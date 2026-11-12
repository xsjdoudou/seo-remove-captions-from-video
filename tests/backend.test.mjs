// 单元测试：覆盖那些出错了也不会立刻显形的纯函数。
//
//   npm test
//
// 挑的都是"错了会安静地造成后果"的地方：文件名清洗（路径穿越、响应头注入）、
// Range 解析（播放器拖进度条、腾讯云取源文件）、dotenv 解析（环境变量优先级）、
// 任务序列化（把内部字段漏给浏览器）。
// 真实的腾讯云链路由 scripts/verify-pipeline.mjs 和 npm run check:tencent 覆盖，
// 它们要花钱和几分钟，不适合放进 npm test。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeFilename, videoExtension, contentTypeFor } from '../scripts/media.mjs'
import { parseEnv } from '../scripts/env.mjs'
import { serializeJob, parseRange, parseAreas } from '../scripts/erase-api.mjs'
import { JobStore } from '../scripts/store.mjs'

test('sanitizeFilename strips directory components', () => {
  assert.equal(sanitizeFilename('../../etc/passwd.mp4'), 'passwd.mp4')
  assert.equal(sanitizeFilename('/absolute/path/clip.mp4'), 'clip.mp4')
  assert.equal(sanitizeFilename('C:\\Users\\me\\clip.mp4'), 'clip.mp4')
})

test('sanitizeFilename removes characters that could break a response header', () => {
  // 带换行的文件名可以往 Content-Disposition 里注入别的头。
  assert.equal(sanitizeFilename('evil\r\nX-Injected: 1.mp4'), 'evil__X-Injected_ 1.mp4')
  assert.equal(sanitizeFilename('quote".mp4'), 'quote_.mp4')
})

test('sanitizeFilename falls back for empty or degenerate input', () => {
  assert.equal(sanitizeFilename(''), 'video.mp4')
  assert.equal(sanitizeFilename('..'), 'video.mp4')
  assert.equal(sanitizeFilename(null), 'video.mp4')
  assert.equal(sanitizeFilename(undefined), 'video.mp4')
})

test('sanitizeFilename keeps non-ASCII names intact', () => {
  // 中文和 emoji 文件名是合法的,不该被清洗掉——只有控制字符和路径分隔符该被换掉。
  assert.equal(sanitizeFilename('我的视频.mp4'), '我的视频.mp4')
  assert.equal(sanitizeFilename('clip 🎬.mov'), 'clip 🎬.mov')
})

test('sanitizeFilename caps the length but keeps the extension', () => {
  const long = `${'a'.repeat(300)}.mp4`
  const result = sanitizeFilename(long)
  assert.ok(result.length <= 120)
  assert.ok(result.endsWith('.mp4'))
})

test('videoExtension accepts known containers and rejects everything else', () => {
  assert.equal(videoExtension('clip.MP4'), '.mp4')
  assert.equal(videoExtension('clip.mov'), '.mov')
  assert.equal(videoExtension('clip.mkv'), '.mkv')
  assert.equal(videoExtension('clip.exe'), null)
  assert.equal(videoExtension('clip.mp4.exe'), null)
  assert.equal(videoExtension('noextension'), null)
})

test('contentTypeFor never guesses a type it does not know', () => {
  assert.equal(contentTypeFor('.mp4'), 'video/mp4')
  assert.equal(contentTypeFor('.bogus'), 'application/octet-stream')
})

test('parseEnv ignores comments and blank lines', () => {
  const parsed = parseEnv('# comment\n\nA=1\n  B = 2  \n')
  assert.deepEqual(parsed, [
    ['A', '1'],
    ['B', '2'],
  ])
})

test('parseEnv unwraps quotes and keeps = inside values', () => {
  const parsed = parseEnv(`A="hello world"\nB='single'\nC=a=b=c\nD="line\\nbreak"`)
  assert.deepEqual(parsed, [
    ['A', 'hello world'],
    ['B', 'single'],
    ['C', 'a=b=c'],
    ['D', 'line\nbreak'],
  ])
})

test('parseEnv skips malformed keys rather than throwing', () => {
  assert.deepEqual(parseEnv('=novalue\n1BAD=x\nGOOD=y'), [['GOOD', 'y']])
})

test('serializeJob never leaks internal fields to the browser', () => {
  const job = {
    id: 'a'.repeat(24),
    token: 'b'.repeat(24),
    status: 'completed',
    filename: 'clip.mp4',
    bytes: 100,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    resultBytes: 90,
    // 这三个绝对不能出现在响应里。
    ip: '203.0.113.9',
    sourcePath: '/srv/data/sources/secret.mp4',
    error: { code: 'processing_failed', message: 'Try another file.', detail: 'bucket=jogg-superres-1305113514 ...' },
  }
  const result = serializeJob(job, { publicBase: '', retentionMs: 86_400_000 })
  const serialized = JSON.stringify(result)

  assert.ok(!serialized.includes('203.0.113.9'), 'client IP leaked')
  assert.ok(!serialized.includes('/srv/data'), 'server path leaked')
  assert.ok(!serialized.includes('jogg-superres'), 'Tencent bucket name leaked')
  assert.equal(result.error.message, 'Try another file.')
  assert.equal(result.error.detail, undefined)
})

test('serializeJob only exposes a result URL once the job is complete', () => {
  const base = { id: 'a'.repeat(24), token: 'b'.repeat(24), filename: 'c.mp4', createdAt: 0, updatedAt: 0 }
  const config = { publicBase: 'https://example.com', retentionMs: 1000 }

  const running = serializeJob({ ...base, status: 'processing' }, config)
  assert.equal(running.resultUrl, null)
  assert.equal(running.downloadUrl, null)

  const done = serializeJob({ ...base, status: 'completed' }, config)
  assert.equal(done.resultUrl, `https://example.com/r/${base.token}.mp4`)
  assert.equal(done.downloadUrl, `https://example.com/r/${base.token}.mp4?download=1`)
})

test('parseAreas accepts an empty selection as "auto mode"', () => {
  // 没画框就是自动模式。空字符串也当没填——浏览器里一个没选中的输入
  // 很容易带着空值进到查询串里。
  assert.deepEqual(parseAreas([]), [])
  assert.deepEqual(parseAreas(['', '  ']), [])
})

test('parseAreas keeps fractions and rounds off the floating point tail', () => {
  assert.deepEqual(parseAreas(['0.1,0.75,0.9,0.95']), [[0.1, 0.75, 0.9, 0.95]])
  // 浏览器量出来的比例尾巴很长，不收口的话同一个框每次提交的参数都不一样。
  assert.deepEqual(parseAreas(['0.100004999,0.2,0.3,0.4']), [[0.1, 0.2, 0.3, 0.4]])
  assert.equal(parseAreas(['0,0.1,0.5,0.6', '0.5,0.1,0.9,0.6']).length, 2)
})

test('parseAreas rejects coordinates that MPS would refuse', () => {
  // percent 坐标必须落在 [0,1) 的开区间里：1 本身也不行。
  assert.throws(() => parseAreas(['0.1,0.2,1,0.9']), /between 0 and 1/)
  assert.throws(() => parseAreas(['-0.1,0.2,0.5,0.9']), /between 0 and 1/)
  assert.throws(() => parseAreas(['0.1,0.2,0.3']), /four numbers/)
  assert.throws(() => parseAreas(['0.1,0.2,abc,0.9']), /four numbers/)
})

test('parseAreas rejects degenerate and oversized selections', () => {
  // 右边界在左边界左边：倒着拖出来的框前端已经归位过，走到这里说明是伪造的。
  assert.throws(() => parseAreas(['0.9,0.2,0.1,0.9']), /at least 1%/)
  // 点一下而不是拖一下。
  assert.throws(() => parseAreas(['0.5,0.5,0.502,0.502']), /at least 1%/)
  const many = Array.from({ length: 7 }, () => '0.1,0.1,0.9,0.9')
  assert.throws(() => parseAreas(many), /At most 6/)
})

test('JobStore assigns distinct unguessable ids and tokens', () => {
  const store = new JobStore('/tmp/does-not-matter.json')
  const a = store.create({ status: 'queued' })
  const b = store.create({ status: 'queued' })

  for (const value of [a.id, a.token, b.id, b.token]) {
    assert.match(value, /^[0-9a-f]{24}$/)
  }
  // id 和 token 必须是两个独立的随机值:拿到公开的源文件 URL 不应该
  // 等于拿到了任务状态(里面带着 IP 和错误详情)。
  assert.notEqual(a.id, a.token)
  assert.equal(new Set([a.id, a.token, b.id, b.token]).size, 4)
})

test('JobStore finds jobs by token and forgets them on delete', () => {
  const store = new JobStore('/tmp/does-not-matter.json')
  const job = store.create({ status: 'queued' })

  assert.equal(store.findByToken(job.token)?.id, job.id)
  assert.equal(store.findByToken('0'.repeat(24)), null)

  store.delete(job.id)
  assert.equal(store.findByToken(job.token), null)
  assert.equal(store.get(job.id), null)
})

test('parseRange handles the forms a video player actually sends', () => {
  assert.deepEqual(parseRange('bytes=0-499', 1000), { start: 0, end: 499 })
  // 开放式区间:播放器开始播放时发的就是这个。
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 })
  // 后缀区间:取文件末尾的 moov box 时用。
  assert.deepEqual(parseRange('bytes=-200', 1000), { start: 800, end: 999 })
  // 超出文件末尾要被截断,而不是让 createReadStream 读到空。
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 })
})

test('parseRange returns null when there is no range to honour', () => {
  assert.equal(parseRange(undefined, 1000), null)
  assert.equal(parseRange('', 1000), null)
  // 不认识的单位不该被当成字节区间处理。
  assert.equal(parseRange('items=0-10', 1000), null)
  // 空文件没有任何区间可发。
  assert.equal(parseRange('bytes=0-10', 0), null)
})

test('parseRange rejects unsatisfiable ranges with 416 rather than serving nothing', () => {
  assert.equal(parseRange('bytes=-', 1000), 'invalid')
  assert.equal(parseRange('bytes=500-100', 1000), 'invalid')
  assert.equal(parseRange('bytes=1000-1500', 1000), 'invalid')
  assert.equal(parseRange('bytes=-0', 1000), 'invalid')
})
