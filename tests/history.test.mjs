// 历史记录的单元测试。
//
// 这块逻辑跑在浏览器里，但它是纯函数加一个 localStorage —— 把 localStorage
// 换成内存实现就能在 node 里测。值得测是因为它的失败方式很安静：
// 存储里混进脏数据、过期条目没被剔除、容量上限没生效，界面上都不会报错，
// 只会默默地显示错的东西或者无限增长。
//
// 被测文件是 TS，而本项目要求的 node 20 还不会剥类型注解（那是 22.6+ 的能力）。
// 所以这里用 vite 公开的 transformWithEsbuild 现场转译一次 —— 只用到已经声明的
// vite 依赖，不引入 tsx/ts-node 这类额外的运行时。history.ts 里只有一个
// `import type`，转译后没有任何运行时依赖，可以直接用 data: URL 加载。

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { transformWithEsbuild } from 'vite'

/** 最小可用的 localStorage，够 history.ts 用。 */
class MemoryStorage {
  #data = new Map()
  getItem(key) {
    return this.#data.has(key) ? this.#data.get(key) : null
  }
  setItem(key, value) {
    this.#data.set(key, String(value))
  }
  removeItem(key) {
    this.#data.delete(key)
  }
  clear() {
    this.#data.clear()
  }
}

const storage = new MemoryStorage()
globalThis.window = { localStorage: storage }

let history

before(async () => {
  const path = fileURLToPath(new URL('../src/lib/history.ts', import.meta.url))
  const source = await fsp.readFile(path, 'utf8')
  const { code } = await transformWithEsbuild(source, path, { loader: 'ts', format: 'esm' })
  history = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
})

beforeEach(() => {
  storage.clear()
})

const HOUR = 3600_000

function job(overrides = {}) {
  const now = Date.now()
  return {
    id: 'a'.repeat(24),
    status: 'processing',
    filename: 'clip.mp4',
    bytes: 1000,
    durationSeconds: 12,
    createdAt: now,
    updatedAt: now,
    submittedAt: now,
    completedAt: null,
    expiresAt: now + 24 * HOUR,
    resultUrl: null,
    downloadUrl: null,
    resultBytes: null,
    error: null,
    ...overrides,
  }
}

test('upsertEntry adds a job and later updates it in place', () => {
  history.upsertEntry(job())
  let entries = history.loadHistory()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].status, 'processing')

  history.upsertEntry(job({ status: 'completed', resultUrl: '/r/x.mp4', downloadUrl: '/r/x.mp4?download=1' }))
  entries = history.loadHistory()
  // 同一个 id 必须是更新,不是再插一条。
  assert.equal(entries.length, 1)
  assert.equal(entries[0].status, 'completed')
  assert.equal(entries[0].downloadUrl, '/r/x.mp4?download=1')
})

test('newest entries come first', () => {
  history.upsertEntry(job({ id: 'a'.repeat(24), filename: 'first.mp4' }))
  history.upsertEntry(job({ id: 'b'.repeat(24), filename: 'second.mp4' }))
  assert.deepEqual(
    history.loadHistory().map((e) => e.filename),
    ['second.mp4', 'first.mp4'],
  )
})

test('loadHistory drops entries whose files the server has already deleted', () => {
  const now = Date.now()
  history.upsertEntry(job({ id: 'a'.repeat(24), expiresAt: now - HOUR }))
  history.upsertEntry(job({ id: 'b'.repeat(24), expiresAt: now + HOUR }))

  const entries = history.loadHistory()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'b'.repeat(24))
})

test('the list is capped so it cannot grow without bound', () => {
  for (let i = 0; i < 30; i += 1) {
    history.upsertEntry(job({ id: i.toString(16).padStart(24, '0'), filename: `clip-${i}.mp4` }))
  }
  const entries = history.loadHistory()
  assert.ok(entries.length <= 12, `expected at most 12 entries, got ${entries.length}`)
  // 留下的应该是最新的那些。
  assert.equal(entries[0].filename, 'clip-29.mp4')
})

test('markExpired keeps the row but takes away the dead links', () => {
  history.upsertEntry(job({ status: 'completed', resultUrl: '/r/x.mp4', downloadUrl: '/r/x.mp4?download=1' }))
  history.markExpired('a'.repeat(24))

  const [entry] = history.loadHistory()
  assert.equal(entry.status, 'expired')
  // 链接必须清掉:留着只会让用户点出一个 404。
  assert.equal(entry.resultUrl, null)
  assert.equal(entry.downloadUrl, null)
})

test('removeEntry and clearHistory', () => {
  history.upsertEntry(job({ id: 'a'.repeat(24) }))
  history.upsertEntry(job({ id: 'b'.repeat(24) }))

  history.removeEntry('a'.repeat(24))
  assert.deepEqual(
    history.loadHistory().map((e) => e.id),
    ['b'.repeat(24)],
  )

  history.clearHistory()
  assert.equal(history.loadHistory().length, 0)
})

test('subscribers are notified on every change', () => {
  const seen = []
  const unsubscribe = history.subscribe((entries) => seen.push(entries.length))

  history.upsertEntry(job({ id: 'a'.repeat(24) }))
  history.upsertEntry(job({ id: 'b'.repeat(24) }))
  history.removeEntry('a'.repeat(24))
  unsubscribe()
  history.upsertEntry(job({ id: 'c'.repeat(24) }))

  // 退订之后不该再收到通知。
  assert.deepEqual(seen, [1, 2, 1])
})

test('corrupted storage is ignored rather than crashing the page', () => {
  storage.setItem('rtfv.history.v1', 'not json at all')
  assert.deepEqual(history.loadHistory(), [])

  storage.setItem('rtfv.history.v1', '{"not":"an array"}')
  assert.deepEqual(history.loadHistory(), [])
})

test('entries with a malformed id are discarded', () => {
  // 手工改过 localStorage 的人不该能把任意字符串喂进 /api/jobs/<id>。
  storage.setItem(
    'rtfv.history.v1',
    JSON.stringify([
      { id: '../../etc/passwd', filename: 'x.mp4', createdAt: Date.now(), expiresAt: Date.now() + HOUR },
      { id: 'NOTHEX'.padEnd(24, 'z'), filename: 'y.mp4', createdAt: Date.now(), expiresAt: Date.now() + HOUR },
      { id: 'f'.repeat(24), filename: 'ok.mp4', createdAt: Date.now(), expiresAt: Date.now() + HOUR },
    ]),
  )
  const entries = history.loadHistory()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].filename, 'ok.mp4')
})
