import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { loadConfig } from '../scripts/config.mjs'
import { createHandler } from '../scripts/erase-api.mjs'
import { probeVideo } from '../scripts/media.mjs'

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0

test('server verifies pricing and submits scaled sources at the requested resolution', { skip: !hasFfmpeg }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolution-billing-'))
  const fakeClient = path.join(dir, 'client.cjs')
  await fs.writeFile(fakeClient, "console.log(JSON.stringify({task_id:'test-task'}))")
  const videoFile = path.join(dir, 'video.mp4')
  const ffmpeg = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=1500x1800:rate=1',
    '-t', '1', '-c:v', 'mpeg4', '-y', videoFile])
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr?.toString())
  const defaults = loadConfig()
  const config = {
    ...defaults, dataDir: dir, sourceDir: path.join(dir, 'sources'), resultDir: path.join(dir, 'results'),
    jobsFile: path.join(dir, 'jobs.json'), usersFile: path.join(dir, 'users.json'),
    auth: { googleClientId: '', sessionSecret: 'a'.repeat(64), cookieSecure: false },
    billing: { enabled: true }, sourcePublicBase: 'https://example.com', pollIntervalMs: 60 * 60 * 1000,
    rateLimitConcurrent: 10, rateLimitDaily: 100,
    tencent: { ...defaults.tencent, ready: true, python: process.execPath, script: fakeClient,
      bucket: 'test', region: 'test', mpsRegion: 'test', secretId: 'test', secretKey: 'test' },
  }
  const { handler, store, users, ledger } = await createHandler(config)
  const server = http.createServer((req, res) => void handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await Promise.all([store.flush(), users.flush()])
    ledger.close()
    await fs.rm(dir, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const registration = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'resolution@example.com', password: 'password123', confirmPassword: 'password123' }),
  })
  const cookie = registration.headers.get('set-cookie').split(';')[0]
  const { user } = await registration.json()
  const data = await fs.readFile(videoFile)
  const upload = (query) => fetch(`${base}/api/jobs?${query}`, {
    method: 'POST', headers: { cookie, 'content-type': 'video/mp4', 'x-filename': 'video.mp4' }, body: data,
  })

  const mismatch = await upload('resolution=original&expectedCredits=1')
  assert.equal(mismatch.status, 409)
  assert.equal((await mismatch.json()).error.requiredCredits, 3)
  assert.equal(ledger.ensureAccount(user.id).total, 15)
  const noConfirmation = await upload('resolution=original')
  assert.equal(noConfirmation.status, 409)
  assert.equal(ledger.balance(user.id).total, 15)

  const original = await upload('resolution=original&expectedCredits=3')
  assert.equal(original.status, 201)
  const originalJob = (await original.json()).job
  assert.equal(store.get(originalJob.id).creditCost, 3)
  const medium = await upload('resolution=1080&expectedCredits=2')
  assert.equal(medium.status, 201)
  const mediumJob = (await medium.json()).job
  assert.equal(store.get(mediumJob.id).creditCost, 2)
  const high = await upload('resolution=1440&expectedCredits=3')
  assert.equal(high.status, 201)
  const highJob = (await high.json()).job
  assert.equal(store.get(highJob.id).creditCost, 3)
  const scaled = await upload('resolution=720&expectedCredits=1')
  assert.equal(scaled.status, 201)
  const scaledJob = (await scaled.json()).job
  assert.equal(store.get(scaledJob.id).creditCost, 1)
  assert.equal(ledger.balance(user.id).total, 6)

  for (let i = 0; i < 500 && [scaledJob, mediumJob, highJob].some((item) => !store.get(item.id).taskId); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  for (const [item, output] of [[mediumJob, 1080], [highJob, 1440]]) {
    const converted = store.get(item.id)
    assert.equal(converted.taskId, 'test-task')
    const metadata = await probeVideo(converted.processingSourcePath)
    assert.equal(Math.min(metadata.width, metadata.height), output)
    assert.ok(Math.abs(metadata.width / metadata.height - 1500 / 1800) < 0.005)
  }
  const job = store.get(scaledJob.id)
  assert.equal(job.taskId, 'test-task')
  assert.ok(job.processingSourcePath)
  const processed = await probeVideo(job.processingSourcePath)
  assert.equal(Math.min(processed.width, processed.height), 720)
  const sourceResponse = await fetch(`${base}/s/${job.token}.mp4`)
  assert.equal(sourceResponse.status, 200)
  assert.equal(sourceResponse.headers.get('content-type'), 'video/mp4')
  await sourceResponse.arrayBuffer()
})
