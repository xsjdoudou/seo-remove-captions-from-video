/**
 * 最近任务记录。
 *
 * 存在 localStorage 里,不在服务端。这不是偷懒:站点没有登录体系,服务端
 * 认不出"你"是谁——真要做成服务端的,就得先发一个长期 cookie 把匿名访客
 * 串起来,那等于为了一个便利功能建了一套追踪。记录放在用户自己的设备上,
 * 隐私承诺不用打折。
 *
 * 代价是换台设备、换个浏览器就看不到了。对一个 24 小时后文件就被删掉的
 * 工具来说,这个取舍是划算的。
 *
 * 真正的数据仍然在服务端:这里存的只是任务 id 和一份用于即时渲染的快照,
 * 状态以 /api/jobs/:id 的返回为准。
 */

import type { Job } from './api'

const STORAGE_KEY = 'rtfv.history.v1'
/** 超过这个数量就丢掉最旧的。文件 24 小时就清了,留太多只是废条目。 */
const MAX_ENTRIES = 12

export interface HistoryEntry {
  id: string
  filename: string
  bytes: number
  durationSeconds: number | null
  createdAt: number
  expiresAt: number
  status: Job['status'] | 'expired'
  resultUrl: string | null
  downloadUrl: string | null
  resultBytes: number | null
  errorMessage: string | null
}

type Listener = (entries: HistoryEntry[]) => void
const listeners = new Set<Listener>()

/** 订阅变更。Workspace 写入、HistoryList 渲染,两者不用互相知道对方存在。 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(entries: HistoryEntry[]): void {
  for (const listener of listeners) listener(entries)
}

/** 读取并顺手剔除已经过期的条目(文件那时已被服务端删掉)。 */
export function loadHistory(): HistoryEntry[] {
  const raw = readRaw()
  const now = Date.now()
  const alive = raw.filter((entry) => entry.expiresAt > now)
  if (alive.length !== raw.length) writeRaw(alive)
  return alive
}

export function upsertEntry(job: Job): HistoryEntry[] {
  const entries = readRaw()
  const entry = toEntry(job)
  const index = entries.findIndex((item) => item.id === entry.id)
  if (index === -1) entries.unshift(entry)
  else entries[index] = { ...entries[index], ...entry }
  const trimmed = entries.slice(0, MAX_ENTRIES)
  writeRaw(trimmed)
  emit(trimmed)
  return trimmed
}

/** 服务端已经不认识这个任务了(过期清理掉了)。 */
export function markExpired(id: string): HistoryEntry[] {
  const entries = readRaw().map((entry) =>
    entry.id === id ? { ...entry, status: 'expired' as const, resultUrl: null, downloadUrl: null } : entry,
  )
  writeRaw(entries)
  emit(entries)
  return entries
}

export function removeEntry(id: string): HistoryEntry[] {
  const entries = readRaw().filter((item) => item.id !== id)
  writeRaw(entries)
  emit(entries)
  return entries
}

export function clearHistory(): HistoryEntry[] {
  writeRaw([])
  emit([])
  return []
}

function toEntry(job: Job): HistoryEntry {
  return {
    id: job.id,
    filename: job.filename,
    bytes: job.bytes,
    durationSeconds: job.durationSeconds,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    status: job.status,
    resultUrl: job.resultUrl,
    downloadUrl: job.downloadUrl,
    resultBytes: job.resultBytes,
    errorMessage: job.error?.message ?? null,
  }
}

/**
 * localStorage 的每一次读写都可能抛异常:隐私模式下禁用、配额满了、
 * 用户关掉了存储权限。历史记录是个锦上添花的功能,它坏掉不该让整个工具
 * 跟着崩,所以这里一律吞掉异常退回空列表。
 */
function readRaw(): HistoryEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    // 存储里的东西可能是上个版本写的,或者被人手工改过,逐条校验。
    return parsed.filter(isEntry)
  } catch {
    return []
  }
}

function writeRaw(entries: HistoryEntry[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    /* 存不下就算了,界面上这一轮的内存状态仍然是对的 */
  }
}

function isEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<HistoryEntry>
  return (
    typeof entry.id === 'string' &&
    // id 必须长得像后端发的那种,免得被塞进奇怪的东西再拼进请求地址。
    /^[0-9a-f]{24}$/.test(entry.id) &&
    typeof entry.filename === 'string' &&
    typeof entry.createdAt === 'number' &&
    typeof entry.expiresAt === 'number'
  )
}
