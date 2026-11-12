// 腾讯云 MPS SmartErase 的 Node 包装层。
//
// 这里不重新实现 TC3 签名，而是把 scripts/tencent_smart_erase.py 当子进程调。
// 理由：签名代码已经跑通并且在生产里验证过，照着移植一遍只会多一处会出
// "signature does not match" 的地方；而每个任务一共只 spawn 十几次 python，
// 开销相对一段视频的处理时间可以忽略。
//
// 密钥只经由子进程的 env 传递，不会出现在命令行里——/proc/<pid>/cmdline
// 同机器上任何用户都读得到。

import { execFile } from 'node:child_process'

/** 子进程最长允许跑多久。submit/query 都是单次 HTTP 调用，60 秒绰绰有余。 */
const CHILD_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 1024 * 1024

export class SmartEraseError extends Error {
  constructor(message, { retryable = false, cause } = {}) {
    super(message, { cause })
    this.name = 'SmartEraseError'
    this.retryable = retryable
  }
}

/**
 * 两个脚本共用的参数。
 *
 * withDefinition：region 脚本把 `--definition` 从它的 parser 里摘掉了
 * （框选任务固定 Definition=0 + RawParameter），再传过去 argparse 会直接
 * 以 "unrecognized arguments" 退出。
 */
function baseArgs(config, { script, withDefinition = true } = {}) {
  const t = config.tencent
  return [
    script ?? t.script,
    '--bucket',
    t.bucket,
    '--output-region',
    t.region,
    '--mps-region',
    t.mpsRegion,
    ...(withDefinition ? ['--definition', String(t.definition)] : []),
    // 成片签名 URL 的有效期。后端拿到就立刻下载，但队列堵住时可能晚几分钟，
    // 留足余量，过期后重新 query 一次就能拿到新的。
    '--signed-url-seconds',
    '3600',
    '--json-errors',
  ]
}

function runPython(config, args, options) {
  return new Promise((resolve, reject) => {
    const t = config.tencent
    execFile(
      t.python,
      [...baseArgs(config, options), ...args],
      {
        timeout: CHILD_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        // cwd 固定在仓库根：python 会把**脚本所在目录**加进 sys.path，
        // 绝不能让它落在 data/ 这种放用户上传文件的目录里。
        cwd: config.repoRoot,
        env: {
          ...process.env,
          TENCENT_SECRET_ID: t.secretId,
          TENCENT_SECRET_KEY: t.secretKey,
          PYTHONIOENCODING: 'utf-8',
        },
      },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim()
        if (!err) {
          try {
            resolve(JSON.parse(out))
          } catch (parseErr) {
            reject(new SmartEraseError(`SmartErase client printed non-JSON: ${out.slice(0, 500)}`, { cause: parseErr }))
          }
          return
        }
        // 子进程被 timeout 杀掉：没有结论，不是失败，下一轮再来。
        if (err.killed || err.signal) {
          reject(new SmartEraseError(`SmartErase client timed out after ${CHILD_TIMEOUT_MS} ms`, { retryable: true, cause: err }))
          return
        }
        // --json-errors 让脚本在失败时也往 stdout 写一个结构化对象。
        let parsed = null
        try {
          parsed = JSON.parse(out)
        } catch {
          /* 下面退回到 stderr 文案 */
        }
        if (parsed?.error?.message) {
          reject(new SmartEraseError(parsed.error.message, { retryable: Boolean(parsed.error.retryable), cause: err }))
          return
        }
        const detail = String(stderr || '').trim().slice(0, 500) || err.message
        // 连结构化输出都没有，多半是 python 本身起不来（缺 requests、路径不对）。
        // 这类问题重试没用，直接判死，让日志里看得见。
        reject(new SmartEraseError(`SmartErase client failed: ${detail}`, { retryable: false, cause: err }))
      },
    )
  })
}

/**
 * 提交一个去字幕任务。
 *
 * 不传 areas 就是自动模式：MPS 自己找字幕。
 * 传了 areas（每个是 [left, top, right, bottom] 四个 0~1 的小数）就走框选模式，
 * 只擦这些矩形里的东西——用户画了框，说明他比检测器更清楚要擦哪儿，
 * 这时候再让模型自己去找反而会擦掉他没要擦的。
 *
 * @returns {Promise<string>} 腾讯云 TaskId
 */
export async function submitTask(config, { inputUrl, sessionId, areas = null }) {
  const common = ['submit', '--input-url', inputUrl, '--session-id', sessionId]

  if (areas?.length) {
    // --area 可以重复，每次四个数；单位用 percent，这样同一组坐标对任何
    // 分辨率的源视频都成立（前端量的本来就是比例，换算成像素只会多一次
    // 取整误差，而且得先知道视频的真实尺寸）。
    const areaArgs = areas.flatMap((area) => ['--area', ...area.map((n) => String(n))])
    const result = await runPython(config, [...common, '--unit', 'percent', ...areaArgs], {
      script: config.tencent.regionScript,
      withDefinition: false,
    })
    const taskId = String(result?.task_id || '').trim()
    if (!taskId) throw new SmartEraseError('SmartErase region submit returned no task id')
    return taskId
  }

  const result = await runPython(config, common)
  const taskId = String(result?.task_id || '').trim()
  if (!taskId) throw new SmartEraseError('SmartErase submit returned no task id')
  return taskId
}

/**
 * 查询任务状态。
 *
 * 两种模式共用这一个：query 只认 TaskId，和当初是怎么提交的无关，
 * 而基础脚本的错误分类（可重试/不可重试）更全。
 * @returns {Promise<{status:'running'}|{status:'completed', videoUrl:string, path:string}>}
 */
export async function queryTask(config, taskId) {
  const result = await runPython(config, ['query', '--task-id', taskId])
  if (result?.status === 'running') return { status: 'running' }
  if (result?.status === 'completed') {
    const videoUrl = String(result.video_url || '').trim()
    if (!videoUrl) throw new SmartEraseError('SmartErase completed without an output URL')
    return { status: 'completed', videoUrl, path: String(result.path || '') }
  }
  throw new SmartEraseError(`SmartErase returned an unexpected status: ${JSON.stringify(result).slice(0, 300)}`)
}
