// 任务状态存储：内存 Map + 落盘 JSON。
//
// 为什么不用数据库：整个站点是单进程、无登录、任务 24 小时后就删掉，
// 常驻任务量是几十条的量级。一个原子写的 JSON 文件足够了，而且运维时
// 可以直接 cat 出来看，不用连客户端。要是以后加了登录和额度，这一层换成
// SQLite，接口形状不用动。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

/** 不可猜测的 id：96 位随机，够当能力凭证（capability URL）用。 */
export function newId() {
  return crypto.randomBytes(12).toString('hex')
}

export const JOB_STATUSES = Object.freeze([
  'uploading', // 正在接收浏览器上传
  'queued', // 已落盘，等待提交到腾讯云
  'submitting', // 正在调 ProcessMedia
  'processing', // 腾讯云在跑，轮询中
  'downloading', // 腾讯云跑完了，正在把成片拉回本地
  'completed',
  'failed',
])

/** 只有这些状态需要后台继续推进；进程重启后据此恢复。 */
export const ACTIVE_STATUSES = Object.freeze(['uploading', 'queued', 'submitting', 'processing', 'downloading'])

export class JobStore {
  #file
  #jobs = new Map()
  #flushTimer = null
  #flushing = null
  #dirty = false

  constructor(file) {
    this.#file = file
  }

  /** 从磁盘载入。文件损坏时就当空库开始，而不是让服务起不来。 */
  async load() {
    let text
    try {
      text = await fsp.readFile(this.#file, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return
      throw err
    }
    try {
      const parsed = JSON.parse(text)
      for (const job of parsed.jobs ?? []) {
        if (job && typeof job.id === 'string') this.#jobs.set(job.id, job)
      }
    } catch {
      // 上一轮进程可能在写到一半时被 kill。重命名留档，别静默删掉。
      const broken = `${this.#file}.broken-${Date.now()}`
      await fsp.rename(this.#file, broken).catch(() => {})
      console.error(`[store] jobs file was unreadable, moved to ${broken} and starting empty`)
    }
  }

  get(id) {
    return this.#jobs.get(id) ?? null
  }

  /** 按文件路径里的 token 查，用于 /s/ 和 /r/ 两个文件路由。 */
  findByToken(token) {
    for (const job of this.#jobs.values()) {
      if (job.token === token) return job
    }
    return null
  }

  list() {
    return [...this.#jobs.values()]
  }

  create(fields) {
    const now = Date.now()
    const job = { id: newId(), token: newId(), createdAt: now, updatedAt: now, ...fields }
    this.#jobs.set(job.id, job)
    this.#scheduleFlush()
    return job
  }

  /** 原地更新并落盘。返回更新后的对象，便于链式使用。 */
  update(id, patch) {
    const job = this.#jobs.get(id)
    if (!job) return null
    Object.assign(job, patch, { updatedAt: Date.now() })
    this.#scheduleFlush()
    return job
  }

  delete(id) {
    const existed = this.#jobs.delete(id)
    if (existed) this.#scheduleFlush()
    return existed
  }

  /** 把写盘推迟 200ms 合并掉轮询期间的高频小改动。 */
  #scheduleFlush() {
    this.#dirty = true
    if (this.#flushTimer) return
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null
      void this.flush()
    }, 200)
    this.#flushTimer.unref?.()
  }

  /** 立刻写盘。并发调用会合流到同一次写。 */
  async flush() {
    if (this.#flushing) return this.#flushing
    if (!this.#dirty) return
    this.#dirty = false
    this.#flushing = (async () => {
      const payload = JSON.stringify({ version: 1, jobs: [...this.#jobs.values()] }, null, 2)
      await fsp.mkdir(path.dirname(this.#file), { recursive: true })
      // 先写临时文件再 rename：rename 在同一文件系统上是原子的，
      // 进程被 kill 时要么是旧版本要么是新版本，不会出现半截 JSON。
      const tmp = `${this.#file}.${process.pid}.tmp`
      await fsp.writeFile(tmp, payload, { mode: 0o600 })
      await fsp.rename(tmp, this.#file)
    })()
    try {
      await this.#flushing
    } finally {
      this.#flushing = null
    }
    // flush 期间可能又被改脏，补一次。
    if (this.#dirty) await this.flush()
  }

  /** 同步落盘，只给退出钩子用——那时候事件循环已经不保证还会转。 */
  flushSync() {
    if (!this.#dirty) return
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true })
      const tmp = `${this.#file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, jobs: [...this.#jobs.values()] }, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, this.#file)
      this.#dirty = false
    } catch (err) {
      console.error(`[store] final flush failed: ${err.message}`)
    }
  }
}
