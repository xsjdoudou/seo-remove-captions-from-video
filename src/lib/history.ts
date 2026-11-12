/**
 * 最近任务记录。
 *
 * 有两种存法，由登录状态决定，对调用方是同一套接口：
 *
 *   未登录 —— 存在 localStorage 里，不上服务端。服务端认不出匿名访客是谁，
 *             真要做成服务端的就得先发一个长期 cookie 把人串起来，那等于
 *             为了一个便利功能建了一套追踪。记录放在用户自己的设备上，
 *             隐私承诺不用打折。代价是换台设备就看不到了。
 *
 *   已登录 —— 存在服务端，挂在账号下。换设备、换浏览器都在。登录那一刻
 *             本地已有的记录会被"认领"过去，用户不会觉得刚才那个任务丢了。
 *
 * 两种模式下真正的数据都在服务端：这里存的只是任务 id 和一份用于即时渲染的
 * 快照，状态以 /api/jobs/:id 的返回为准。
 */

import { claimJobs, deleteJob, fetchJobs, type Job } from './api'

const STORAGE_KEY = 'rtfv.history.v1'
/** 匿名模式下超过这个数量就丢掉最旧的。文件 24 小时就清了，留太多只是废条目。 */
const MAX_ENTRIES = 12

export interface HistoryEntry {
  id: string
  filename: string
  bytes: number
  durationSeconds: number | null
  createdAt: number
  expiresAt: number
  status: Job['status']
  resultUrl: string | null
  downloadUrl: string | null
  resultBytes: number | null
  errorMessage: string | null
}

type Listener = (entries: HistoryEntry[]) => void
const listeners = new Set<Listener>()

/**
 * 服务端模式下的内存副本。
 *
 * 这是一份缓存而不是真相：每次服务端告诉我们更新的内容（列表、单个任务的
 * 轮询结果）就覆盖掉它，组件订阅它来渲染。
 */
let serverEntries: HistoryEntry[] | null = null

/** 订阅变更。Workspace 写入、HistoryList 渲染，两者不用互相知道对方存在。 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(entries: HistoryEntry[]): void {
  for (const listener of listeners) listener(entries)
}

/** 当前是不是服务端模式。切换由 enterServerMode / enterLocalMode 驱动。 */
function isServerMode(): boolean {
  return serverEntries !== null
}

/**
 * 切到服务端模式（用户刚登录，或页面加载时发现已登录）。
 *
 * 先把本地历史认领过去再拉列表：顺序反过来的话，用户会看到列表先少后多地
 * 跳一下。认领失败不影响登录本身，退回到只拉列表。
 */
export async function enterServerMode(): Promise<HistoryEntry[]> {
  const localIds = readRaw().map((entry) => entry.id)
  let jobs: Job[]
  try {
    jobs = await claimJobs(localIds)
    // 认领成功之后本地那份就是多余的了。留着它，用户登出时会看到一份
    // 和账号里重复的旧快照。
    if (localIds.length > 0) writeRaw([])
  } catch {
    jobs = await fetchJobs()
  }
  serverEntries = jobs.map(toEntry)
  emit(serverEntries)
  return serverEntries
}

/** 切回本地模式（用户登出，或服务端没开登录）。 */
export function enterLocalMode(): HistoryEntry[] {
  serverEntries = null
  const entries = loadHistory()
  emit(entries)
  return entries
}

/** 读取当前模式下的列表。本地模式下顺手剔除已经过期的条目。 */
export function loadHistory(): HistoryEntry[] {
  if (serverEntries) return serverEntries
  const raw = readRaw()
  const now = Date.now()
  const alive = raw.filter((entry) => entry.expiresAt > now)
  if (alive.length !== raw.length) writeRaw(alive)
  return alive
}

/**
 * 记下一个任务的最新状态。
 *
 * 服务端模式下**不往服务端写**：任务本来就是服务端建的，它那边已经是最新的。
 * 这里只更新内存副本，让界面立刻动起来，不用等下一次拉列表。
 */
export function upsertEntry(job: Job): HistoryEntry[] {
  const entry = toEntry(job)
  if (serverEntries) {
    const index = serverEntries.findIndex((item) => item.id === entry.id)
    if (index === -1) serverEntries = [entry, ...serverEntries]
    else serverEntries = serverEntries.map((item, i) => (i === index ? { ...item, ...entry } : item))
    emit(serverEntries)
    return serverEntries
  }

  const entries = readRaw()
  const index = entries.findIndex((item) => item.id === entry.id)
  if (index === -1) entries.unshift(entry)
  else entries[index] = { ...entries[index], ...entry }
  const trimmed = entries.slice(0, MAX_ENTRIES)
  writeRaw(trimmed)
  emit(trimmed)
  return trimmed
}

/** 服务端已经不认识这个任务了（过期清理掉了）。 */
export function markExpired(id: string): HistoryEntry[] {
  const patch = (entry: HistoryEntry): HistoryEntry =>
    entry.id === id ? { ...entry, status: 'expired' as const, resultUrl: null, downloadUrl: null } : entry

  if (serverEntries) {
    serverEntries = serverEntries.map(patch)
    emit(serverEntries)
    return serverEntries
  }
  const entries = readRaw().map(patch)
  writeRaw(entries)
  emit(entries)
  return entries
}

/**
 * 从列表里移掉一条。
 *
 * 两种模式下这个动作的含义不同，而用户按的是同一个 ×：
 *   本地模式 —— 只是把这条记录从这台浏览器里抹掉，服务端的文件到点自己会删。
 *   服务端模式 —— 必须真的删掉服务端那份，否则下次拉列表它又回来了。
 */
export function removeEntry(id: string): HistoryEntry[] {
  if (serverEntries) {
    serverEntries = serverEntries.filter((item) => item.id !== id)
    emit(serverEntries)
    void deleteJob(id)
    return serverEntries
  }
  const entries = readRaw().filter((item) => item.id !== id)
  writeRaw(entries)
  emit(entries)
  return entries
}

export function clearHistory(): HistoryEntry[] {
  if (serverEntries) {
    const ids = serverEntries.map((entry) => entry.id)
    serverEntries = []
    emit(serverEntries)
    for (const id of ids) void deleteJob(id)
    return serverEntries
  }
  writeRaw([])
  emit([])
  return []
}

/** 服务端模式下，从服务端重新拉一次完整列表。 */
export async function refreshFromServer(): Promise<HistoryEntry[]> {
  if (!isServerMode()) return loadHistory()
  serverEntries = (await fetchJobs()).map(toEntry)
  emit(serverEntries)
  return serverEntries
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
 * localStorage 的每一次读写都可能抛异常：隐私模式下禁用、配额满了、
 * 用户关掉了存储权限。历史记录是个锦上添花的功能，它坏掉不该让整个工具
 * 跟着崩，所以这里一律吞掉异常退回空列表。
 */
function readRaw(): HistoryEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    // 存储里的东西可能是上个版本写的，或者被人手工改过，逐条校验。
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
    /* 存不下就算了，界面上这一轮的内存状态仍然是对的 */
  }
}

function isEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<HistoryEntry>
  return (
    typeof entry.id === 'string' &&
    // id 必须长得像后端发的那种，免得被塞进奇怪的东西再拼进请求地址。
    /^[0-9a-f]{24}$/.test(entry.id) &&
    typeof entry.filename === 'string' &&
    typeof entry.createdAt === 'number' &&
    typeof entry.expiresAt === 'number'
  )
}
