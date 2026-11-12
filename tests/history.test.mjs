// 历史记录的单元测试。
//
// 这块逻辑跑在浏览器里，但它是纯函数加一个 localStorage / 一组 fetch ——
// 把这两样换成测试替身就能在 node 里测。值得测是因为它的失败方式很安静：
// 存储里混进脏数据、过期条目没被剔除、容量上限没生效、登录后漏掉本地记录，
// 界面上都不会报错，只会默默地显示错的东西或者无限增长。
//
// 被测文件是 TS，而本项目要求的 node 20 还不会剥类型注解（那是 22.6+ 的能力）。
// 所以这里用 vite 公开的 transformWithEsbuild 现场转译一次 —— 只用到已经声明的
// vite 依赖，不引入 tsx/ts-node 这类额外的运行时。
//
// history.ts 现在真的 import 了 ./api（登录之后历史存在服务端）。data: URL
// 模块解析不了相对路径，所以转译前把那个 specifier 换成下面这个桩模块，
// 它把调用转发到 globalThis.__api —— 每个用例因此能自己决定服务端怎么回应。

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

/** 被测代码看到的 ./api。默认什么都不做，用例按需覆盖。 */
const api = {
  claimJobs: async () => [],
  fetchJobs: async () => [],
  deleted: [],
  deleteJob: async (id) => {
    api.deleted.push(id)
  },
}
globalThis.__api = api

const API_STUB = `
  export const claimJobs = (ids) => globalThis.__api.claimJobs(ids)
  export const fetchJobs = () => globalThis.__api.fetchJobs()
  export const deleteJob = (id) => globalThis.__api.deleteJob(id)
`

function dataModule(code) {
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
}

let history

before(async () => {
  const path = fileURLToPath(new URL('../src/lib/history.ts', import.meta.url))
  const raw = await fsp.readFile(path, 'utf8')
  const source = raw.replace(/from '\.\/api'/, `from '${dataModule(API_STUB)}'`)
  assert.notEqual(source, raw, "the ./api import moved — this stub no longer applies")
  const { code } = await transformWithEsbuild(source, path, { loader: 'ts', format: 'esm' })
  history = await import(dataModule(code))
})

beforeEach(() => {
  storage.clear()
  api.deleted = []
  api.claimJobs = async () => []
  api.fetchJobs = async () => []
  // serverEntries 是模块级状态，用例之间必须归零，否则上一个登录态的
  // 测试会让下一个本地模式的测试读到服务端那份列表。
  history.enterLocalMode()
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

// ── 登录态切换 ──────────────────────────────────────────────────────────
//
// 这一组测的是"用户登录/登出那一刻，他的记录去哪了"。做错了不会报错，
// 只会让人觉得自己的任务凭空消失了——而那恰恰是最伤信任的一种 bug。

test('signing in claims the jobs started anonymously on this browser', () => {
  // 典型路径：先匿名传一个视频，觉得好用，然后登录。刚才那个任务必须还在。
  const local = job({ id: 'a'.repeat(24), filename: 'anonymous.mp4' })
  history.upsertEntry(local)

  let claimedIds = null
  api.claimJobs = async (ids) => {
    claimedIds = ids
    return [job({ id: 'a'.repeat(24), filename: 'anonymous.mp4', status: 'completed' })]
  }

  return history.enterServerMode().then((entries) => {
    assert.deepEqual(claimedIds, ['a'.repeat(24)])
    assert.equal(entries.length, 1)
    assert.equal(entries[0].filename, 'anonymous.mp4')
    assert.equal(entries[0].status, 'completed')
    // 认领之后本地那份是多余的。留着它，用户登出时会看到一份重复的旧快照。
    assert.deepEqual(JSON.parse(storage.getItem('rtfv.history.v1')), [])
  })
})

test('signing in shows the account history from other devices', async () => {
  api.claimJobs = async () => [
    job({ id: 'b'.repeat(24), filename: 'from-my-laptop.mp4', status: 'completed' }),
    job({ id: 'c'.repeat(24), filename: 'from-my-phone.mp4', status: 'completed' }),
  ]
  const entries = await history.enterServerMode()
  assert.deepEqual(entries.map((entry) => entry.filename), ['from-my-laptop.mp4', 'from-my-phone.mp4'])
})

test('a failed claim still shows the account history', async () => {
  // 认领是锦上添花。它挂了不该让用户登录之后看到一个空列表。
  api.claimJobs = async () => {
    throw new Error('network')
  }
  api.fetchJobs = async () => [job({ id: 'd'.repeat(24), filename: 'still-here.mp4' })]

  const entries = await history.enterServerMode()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].filename, 'still-here.mp4')
})

test('in server mode, removing a row deletes it on the server too', async () => {
  // 本地模式下 × 只是从这台浏览器里抹掉一条；服务端模式下不真删的话，
  // 下次拉列表它又回来了。同一个按钮，两种含义。
  api.claimJobs = async () => [job({ id: 'e'.repeat(24) }), job({ id: 'f'.repeat(24) })]
  await history.enterServerMode()

  const left = history.removeEntry('e'.repeat(24))
  assert.deepEqual(left.map((entry) => entry.id), ['f'.repeat(24)])
  assert.deepEqual(api.deleted, ['e'.repeat(24)])
})

test('in local mode, removing a row leaves the server alone', () => {
  // 匿名任务的文件到点自己会被清掉，没必要——也没凭据——去动服务端。
  history.upsertEntry(job({ id: 'a'.repeat(24) }))
  history.removeEntry('a'.repeat(24))
  assert.deepEqual(api.deleted, [])
})

test('clearing in server mode deletes every job on the server', async () => {
  api.claimJobs = async () => [job({ id: 'e'.repeat(24) }), job({ id: 'f'.repeat(24) })]
  await history.enterServerMode()

  assert.deepEqual(history.clearHistory(), [])
  assert.deepEqual(api.deleted.sort(), ['e'.repeat(24), 'f'.repeat(24)])
})

test('in server mode, upsertEntry updates the view without writing to localStorage', async () => {
  // 任务本来就是服务端建的，它那边已经是最新的。这里只更新内存副本，
  // 让界面立刻动起来。顺手写进 localStorage 的话，登出后会冒出一份
  // 属于账号的记录——那是泄漏，不是便利。
  api.claimJobs = async () => [job({ id: 'e'.repeat(24), status: 'processing' })]
  await history.enterServerMode()

  const entries = history.upsertEntry(job({ id: 'e'.repeat(24), status: 'completed' }))
  assert.equal(entries[0].status, 'completed')
  assert.deepEqual(JSON.parse(storage.getItem('rtfv.history.v1') ?? '[]'), [])
})

test('signing out goes back to this browser’s own list', async () => {
  api.claimJobs = async () => [job({ id: 'e'.repeat(24), filename: 'account.mp4' })]
  await history.enterServerMode()
  assert.equal(history.loadHistory()[0].filename, 'account.mp4')

  // 登出之后账号里的记录必须从界面上消失——哪怕下一个用这台电脑的人
  // 只是打开了同一个标签页。
  assert.deepEqual(history.enterLocalMode(), [])
  assert.deepEqual(history.loadHistory(), [])
})

test('subscribers are notified when the mode changes', async () => {
  const seen = []
  const unsubscribe = history.subscribe((entries) => seen.push(entries.length))

  api.claimJobs = async () => [job({ id: 'e'.repeat(24) }), job({ id: 'f'.repeat(24) })]
  await history.enterServerMode()
  history.enterLocalMode()
  unsubscribe()

  assert.deepEqual(seen, [2, 0])
})
