// 任务流水线：把一个已经落盘的上传，推到"本地有成片"为止。
//
//   queued → submitting → processing → downloading → completed
//
// 每一步的状态都写回 JobStore，前端轮询 /api/jobs/:id 就能看到进展。
// 进程重启后 resume() 会把没跑完的任务重新接上。

import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline as streamPipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createWriteStream } from 'node:fs'

import { submitTask, queryTask, SmartEraseError } from './tencent.mjs'
import { ACTIVE_STATUSES } from './store.mjs'

/** 连续多少次可重试的失败之后放弃。5 次 × 退避 ≈ 几分钟，够熬过一般的抖动。 */
const MAX_RETRYABLE_FAILURES = 5
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

export class Pipeline {
  #config
  #store
  #running = new Set()

  constructor(config, store) {
    this.#config = config
    this.#store = store
  }

  get activeCount() {
    return this.#running.size
  }

  /**
   * 某个主体（登录账号，或匿名访客的 IP）当前有几个任务在跑。限流用。
   *
   * 传一个 { field, value } 而不是两个可选参数：调用方必须在"按账号"和
   * "按 IP"之间二选一，不会出现两个都传、规则含糊的中间状态。
   */
  activeCountForOwner({ field, value }) {
    let n = 0
    for (const job of this.#store.list()) {
      if (job[field] === value && ACTIVE_STATUSES.includes(job.status)) n += 1
    }
    return n
  }

  /** 启动（或重新接上）一个任务。同一个 id 重复调用是安全的。 */
  start(jobId) {
    if (this.#running.has(jobId)) return
    this.#running.add(jobId)
    this.#run(jobId)
      .catch((err) => {
        // #run 内部已经把失败写进 store 了，走到这里说明是预期外的异常。
        console.error(`[pipeline] job ${jobId} crashed: ${err?.stack || err}`)
        this.#store.update(jobId, { status: 'failed', error: publicError(err) })
      })
      .finally(() => {
        this.#running.delete(jobId)
      })
  }

  /** 进程启动时调用：把上一轮没跑完的任务捡起来。 */
  resume() {
    for (const job of this.#store.list()) {
      if (!ACTIVE_STATUSES.includes(job.status)) continue
      if (job.status === 'uploading') {
        // 上传是跟着 HTTP 请求走的，进程一没了这个任务就不可能再完成。
        this.#store.update(job.id, {
          status: 'failed',
          error: { code: 'upload_interrupted', message: 'Upload was interrupted. Please try again.' },
        })
        continue
      }
      console.log(`[pipeline] resuming job ${job.id} (${job.status})`)
      this.start(job.id)
    }
  }

  async #run(jobId) {
    const job = this.#store.get(jobId)
    if (!job) return

    const deadline = (job.submittedAt ?? Date.now()) + this.#config.jobTimeoutMs
    let taskId = job.taskId ?? null

    if (!taskId) {
      taskId = await this.#submit(jobId)
      if (!taskId) return
    }

    const output = await this.#poll(jobId, taskId, deadline)
    if (!output) return

    await this.#download(jobId, output.videoUrl)
  }

  async #submit(jobId) {
    const job = this.#store.update(jobId, { status: 'submitting', submittedAt: Date.now() })
    const inputUrl = this.sourceUrlFor(job)
    if (!inputUrl) {
      this.#store.update(jobId, {
        status: 'failed',
        error: {
          code: 'source_url_unreachable',
          message: 'The server has no public address configured, so the processing API cannot fetch your video.',
        },
      })
      console.error('[pipeline] SOURCE_PUBLIC_BASE is unset — Tencent MPS cannot fetch http://127.0.0.1')
      return null
    }

    try {
      // SessionId 用 job.token：MPS 拿它做任务去重，所以进程重启后重新提交
      // 同一个任务不会变成两次计费的重复任务。
      const taskId = await this.#withRetry(jobId, () =>
        submitTask(this.#config, { inputUrl, sessionId: job.token, areas: job.areas ?? null }),
      )
      this.#store.update(jobId, { taskId, status: 'processing' })
      console.log(`[pipeline] job ${jobId} submitted as task ${taskId} (${job.mode ?? 'auto'} mode)`)
      return taskId
    } catch (err) {
      this.#store.update(jobId, { status: 'failed', error: publicError(err) })
      return null
    }
  }

  async #poll(jobId, taskId, deadline) {
    while (true) {
      if (Date.now() > deadline) {
        this.#store.update(jobId, {
          status: 'failed',
          error: { code: 'timeout', message: 'Processing took longer than expected and was given up on.' },
        })
        return null
      }
      // 先睡再查：刚提交完立刻查一次基本一定是 running，白白多一次 spawn。
      await sleep(this.#config.pollIntervalMs)
      if (!this.#store.get(jobId)) return null // 被用户删了

      let result
      try {
        result = await this.#withRetry(jobId, () => queryTask(this.#config, taskId))
      } catch (err) {
        this.#store.update(jobId, { status: 'failed', error: publicError(err) })
        return null
      }
      if (result.status === 'completed') return result
      this.#store.update(jobId, { status: 'processing' })
    }
  }

  async #download(jobId, videoUrl) {
    const job = this.#store.update(jobId, { status: 'downloading' })
    if (!job) return
    const target = path.join(this.#config.resultDir, `${job.token}.mp4`)
    await fsp.mkdir(this.#config.resultDir, { recursive: true })

    try {
      const bytes = await downloadToFile(videoUrl, target, this.#config.maxUploadBytes * 2)
      this.#store.update(jobId, {
        status: 'completed',
        resultPath: target,
        resultBytes: bytes,
        completedAt: Date.now(),
      })
      console.log(`[pipeline] job ${jobId} completed (${(bytes / 1024 / 1024).toFixed(1)} MB)`)
      // 成片已经在本地了，源视频没有继续留着的理由——它还挂在一个公网可取的
      // URL 上，早一点删掉就少一段暴露窗口。
      await this.#deleteSource(jobId)
    } catch (err) {
      await fsp.rm(target, { force: true }).catch(() => {})
      this.#store.update(jobId, {
        status: 'failed',
        error: { code: 'download_failed', message: `Could not fetch the processed video: ${err.message}` },
      })
    }
  }

  async #deleteSource(jobId) {
    const job = this.#store.get(jobId)
    if (!job?.sourcePath) return
    await fsp.rm(job.sourcePath, { force: true }).catch(() => {})
    this.#store.update(jobId, { sourcePath: null })
  }

  /** 可重试的错误退避重试；不可重试的直接抛出去。 */
  async #withRetry(jobId, fn) {
    let failures = 0
    while (true) {
      try {
        return await fn()
      } catch (err) {
        if (!(err instanceof SmartEraseError) || !err.retryable) throw err
        failures += 1
        if (failures >= MAX_RETRYABLE_FAILURES) throw err
        const backoffMs = Math.min(60_000, 2 ** failures * 1000)
        console.warn(`[pipeline] job ${jobId} transient failure ${failures}/${MAX_RETRYABLE_FAILURES}: ${err.message}`)
        await sleep(backoffMs)
      }
    }
  }

  /**
   * 腾讯云去取源视频用的 URL。
   *
   * 必须是公网可达的地址：MPS 在腾讯的机房里发起 GET，127.0.0.1 对它来说
   * 是它自己。没配 SOURCE_PUBLIC_BASE 就返回 null，让调用方给出清楚的报错，
   * 而不是提交上去等一个语焉不详的下载失败。
   */
  sourceUrlFor(job) {
    const base = this.#config.sourcePublicBase
    if (!base) return null
    return `${base}/s/${job.token}${job.extension}`
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * 流式下载到文件，边下边数字节数，超限就中断。
 *
 * 不用 arrayBuffer()：成片可能几百 MB，整个读进内存就是一次 OOM。
 */
async function downloadToFile(url, target, maxBytes) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (!response.body) throw new Error('empty response body')

    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > maxBytes) throw new Error(`response is ${declared} bytes, over the ${maxBytes} byte limit`)

    let received = 0
    const counter = new TransformStream({
      transform(chunk, ctrl) {
        received += chunk.byteLength
        if (received > maxBytes) throw new Error(`response exceeded the ${maxBytes} byte limit`)
        ctrl.enqueue(chunk)
      },
    })
    await streamPipeline(Readable.fromWeb(response.body.pipeThrough(counter)), createWriteStream(target, { mode: 0o600 }))
    if (received === 0) throw new Error('downloaded 0 bytes')
    return received
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把内部错误转成能给用户看的形状——别把密钥、桶名或内网地址漏到浏览器里。
 *
 * detail 留在 job 里只为了服务端排障，serializeJob 不会把它发出去。
 * 同时往 stderr 打一份：否则线上唯一能看到真实原因的地方是 jobs.json，
 * 排障时得先 ssh 上去 cat 一个 JSON 文件才知道腾讯云到底说了什么。
 */
function publicError(err) {
  const detail = String(err?.message || err)
  console.error(`[pipeline] ${detail}`)
  if (err instanceof SmartEraseError) {
    return { code: 'processing_failed', message: 'The video could not be processed. Please try another file.', detail }
  }
  return { code: 'internal_error', message: 'Something went wrong on our side. Please try again.', detail }
}
