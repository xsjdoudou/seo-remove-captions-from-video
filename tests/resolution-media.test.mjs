import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { probeVideo, transcodeResolution } from '../scripts/media.mjs'
import { JobStore } from '../scripts/store.mjs'
import { CreditLedger } from '../scripts/credits.mjs'
import { Pipeline } from '../scripts/pipeline.mjs'

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0

for (const [size, output] of [['1282x722', 720], ['722x1282', 720], ['1600x1200', 1080], ['1500x1800', 1440]]) {
  test(`${output}p conversion preserves orientation and aspect ratio for ${size}`, { skip: !hasFfmpeg }, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-resolution-'))
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    const source = path.join(dir, 'source.mp4')
    const target = path.join(dir, 'target.mp4')
    const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=size=${size}:rate=1`,
      '-t', '1', '-c:v', 'mpeg4', '-y', source])
    assert.equal(generated.status, 0, generated.stderr?.toString())
    const before = await probeVideo(source)
    await transcodeResolution(source, target, 20_000_000, output)
    const after = await probeVideo(target)
    assert.equal(Math.min(after.width, after.height), output)
    assert.equal(before.width > before.height, after.width > after.height)
    assert.ok(Math.abs(before.width / before.height - after.width / after.height) < 0.005)
    assert.ok(after.duration > 0)
    await fs.access(source)
  })
}

test('a failed conversion removes its temporary output', { skip: !hasFfmpeg }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-resolution-error-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'invalid.mp4')
  const target = path.join(dir, 'target.mp4')
  await fs.writeFile(source, 'not video')
  await assert.rejects(transcodeResolution(source, target, 20_000_000, 720))
  await assert.rejects(fs.access(`${target}.tmp.mp4`), { code: 'ENOENT' })
})

test('a failed 720p conversion refunds the reserved credits', { skip: !hasFfmpeg }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-resolution-refund-'))
  const ledger = new CreditLedger(path.join(dir, 'credits.sqlite'))
  const store = new JobStore(path.join(dir, 'jobs.json'))
  t.after(async () => {
    await store.flush()
    ledger.close()
    await fs.rm(dir, { recursive: true, force: true })
  })
  const source = path.join(dir, 'invalid.mp4')
  await fs.writeFile(source, 'not video')
  const job = store.create({ status: 'queued', userId: 'user', sourcePath: source, outputResolution: '720',
    videoWidth: 1920, videoHeight: 1080, billable: true })
  ledger.ensureAccount('user')
  assert.equal(ledger.reserve('user', job.id, 10), 'reserved')
  let finish
  const finished = new Promise((resolve) => { finish = resolve })
  const pipeline = new Pipeline({ sourceDir: dir, maxUploadBytes: 20_000_000, jobTimeoutMs: 60_000 }, store,
    async (id) => { ledger.settle(id, false); finish() })
  pipeline.start(job.id)
  await finished
  assert.equal(store.get(job.id).status, 'failed')
  assert.equal(ledger.balance('user').total, 15)
  assert.equal(ledger.pendingReservations().length, 0)
})
