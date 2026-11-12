// 任务状态存储：内存 Map + 落盘 JSON。
//
// 为什么不用数据库：整个站点是单进程，任务文件 24 小时后就删掉，常驻任务量是
// 几十到几百条的量级。一个原子写的 JSON 文件足够了，而且运维时可以直接 cat
// 出来看，不用连客户端。加了 Google 登录之后多出一张用户表，两张表共用下面
// 的 JsonTable——账号数据同样是几百条的量级，换 SQLite 的那一天再换，
// 接口形状不用动。

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

/**
 * 一张落在单个 JSON 文件里的表。
 *
 * 只做三件事：进程启动时读进内存、改动合并后原子写回、退出时同步落盘。
 * 子类负责"一行长什么样"。
 */
export class JsonTable {
  #file
  #key
  #flushTimer = null
  #flushing = null
  #dirty = false

  /** 子类要读写行，所以这张 Map 是内部可见的（下划线=本模块与子类专用）。 */
  _items = new Map()

  /** @param key 落盘 JSON 里装数组的字段名，顺带当成文件内容的自描述标签。 */
  constructor(file, key) {
    this.#file = file
    this.#key = key
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
      for (const row of parsed[this.#key] ?? []) {
        if (row && typeof row.id === 'string') this._items.set(row.id, row)
      }
    } catch {
      // 上一轮进程可能在写到一半时被 kill。重命名留档，别静默删掉。
      const broken = `${this.#file}.broken-${Date.now()}`
      await fsp.rename(this.#file, broken).catch(() => {})
      console.error(`[store] ${this.#key} file was unreadable, moved to ${broken} and starting empty`)
    }
  }

  get(id) {
    return this._items.get(id) ?? null
  }

  list() {
    return [...this._items.values()]
  }

  /** 原地更新并落盘。返回更新后的对象，便于链式使用。 */
  update(id, patch) {
    const row = this._items.get(id)
    if (!row) return null
    Object.assign(row, patch, { updatedAt: Date.now() })
    this._scheduleFlush()
    return row
  }

  delete(id) {
    const existed = this._items.delete(id)
    if (existed) this._scheduleFlush()
    return existed
  }

  /** 把写盘推迟 200ms 合并掉轮询期间的高频小改动。 */
  _scheduleFlush() {
    this.#dirty = true
    if (this.#flushTimer) return
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null
      void this.flush()
    }, 200)
    this.#flushTimer.unref?.()
  }

  #serialize() {
    return JSON.stringify({ version: 1, [this.#key]: [...this._items.values()] }, null, 2)
  }

  /** 立刻写盘。并发调用会合流到同一次写。 */
  async flush() {
    if (this.#flushing) return this.#flushing
    if (!this.#dirty) return
    this.#dirty = false
    this.#flushing = (async () => {
      const payload = this.#serialize()
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
      fs.writeFileSync(tmp, this.#serialize(), { mode: 0o600 })
      fs.renameSync(tmp, this.#file)
      this.#dirty = false
    } catch (err) {
      console.error(`[store] final flush of ${this.#key} failed: ${err.message}`)
    }
  }
}

export class JobStore extends JsonTable {
  constructor(file) {
    super(file, 'jobs')
  }

  /** 按文件路径里的 token 查，用于 /s/ 和 /r/ 两个文件路由。 */
  findByToken(token) {
    for (const job of this._items.values()) {
      if (job.token === token) return job
    }
    return null
  }

  /**
   * 某个用户的任务，新的在前。
   *
   * 没有 userId 的任务是匿名访客的，永远不会被任何用户列出来——它们的历史
   * 只存在于那台浏览器的 localStorage 里。
   */
  listByUser(userId, { limit = 50, offset = 0 } = {}) {
    if (!userId) return { jobs: [], total: 0 }
    const owned = this.list().filter((job) => job.userId === userId)
    owned.sort((a, b) => b.createdAt - a.createdAt)
    const start = Math.max(0, offset)
    return { jobs: owned.slice(start, start + Math.max(0, limit)), total: owned.length }
  }

  create(fields) {
    const now = Date.now()
    const job = { id: newId(), token: newId(), createdAt: now, updatedAt: now, ...fields }
    this._items.set(job.id, job)
    this._scheduleFlush()
    return job
  }
}

/**
 * 登录用户。
 *
 * id 是 `google:<sub>`：sub 是 Google 账号的稳定标识，邮箱不是（用户可以改
 * 邮箱，企业账号还能被重新分配）。带上提供方前缀，将来接第二家登录时
 * 两边的 id 不会撞上。
 */
export class UserStore extends JsonTable {
  constructor(file) {
    super(file, 'users')
  }

  /** 登录成功后写一次。已存在就刷新资料——用户改了头像或名字应该跟着变。 */
  upsert(id, profile) {
    const now = Date.now()
    const existing = this._items.get(id)
    if (existing) {
      Object.assign(existing, profile, { updatedAt: now, lastSeenAt: now })
      this._scheduleFlush()
      return existing
    }
    const user = { id, ...profile, createdAt: now, updatedAt: now, lastSeenAt: now }
    this._items.set(id, user)
    this._scheduleFlush()
    return user
  }

  /** 每次带着有效会话来访时刷新，用于清理长期不用的账号。 */
  touch(id) {
    const user = this._items.get(id)
    if (!user) return null
    const now = Date.now()
    // 一天内重复访问不必每次都把整张表写回磁盘。
    if (now - (user.lastSeenAt ?? 0) > 24 * 60 * 60 * 1000) {
      user.lastSeenAt = now
      this._scheduleFlush()
    }
    return user
  }
}
