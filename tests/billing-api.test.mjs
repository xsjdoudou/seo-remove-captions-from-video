import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { loadConfig } from '../scripts/config.mjs'
import { createHandler } from '../scripts/erase-api.mjs'

test('billing requires login and grants each account credits only once', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rtfv-billing-'))
  const config = {
    ...loadConfig(), dataDir: dir, sourceDir: path.join(dir, 'sources'), resultDir: path.join(dir, 'results'),
    jobsFile: path.join(dir, 'jobs.json'), usersFile: path.join(dir, 'users.json'),
    auth: { googleClientId: '', sessionSecret: 'a'.repeat(64), cookieSecure: false },
    billing: { enabled: true }, tencent: { ready: true }, sourcePublicBase: 'https://example.com',
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicKeyFile = path.join(dir, 'public.pem')
  await fs.writeFile(publicKeyFile, publicKey.export({ type: 'spki', format: 'pem' }))
  config.billing.storeId = 'STO_test'
  config.billing.webhookPublicKeyFile = publicKeyFile
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
  assert.equal((await fetch(base + '/api/billing/account')).status, 401)
  assert.equal((await fetch(base + '/api/jobs', { method: 'POST' })).status, 401)
  const unsigned = await fetch(base + '/api/billing/waffo-webhook', { method: 'POST', body: '{}' })
  assert.equal(unsigned.status, 401)
  const register = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'billing@example.com', password: 'password123', confirmPassword: 'password123' }),
  })
  const cookie = register.headers.get('set-cookie').split(';')[0]
  const userId = (await register.json()).user.id
  config.rateLimitDailyExemptUsers = [userId]
  config.fullAccessUsers = []
  for (let i = 0; i < 2; i++) {
    const response = await fetch(base + '/api/billing/account', { headers: { cookie } })
    assert.equal((await response.json()).balance.total, 15)
  }
  const videoFile = path.join(dir, 'test.mp4')
  const ffmpeg = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=16x16:rate=1',
    '-t', '16', '-c:v', 'mpeg4', '-y', videoFile])
  if (ffmpeg.error?.code !== 'ENOENT') {
    assert.equal(ffmpeg.status, 0, ffmpeg.stderr?.toString())
    const upload = await fetch(base + '/api/jobs?expectedCredits=16', {
      method: 'POST', headers: { cookie, 'content-type': 'video/mp4', 'x-filename': 'test.mp4' },
      body: await fs.readFile(videoFile),
    })
    assert.equal(upload.status, 402)
    const { error } = await upload.json()
    assert.equal(error.code, 'insufficient_credits')
    assert.equal(error.requiredCredits, 16)
    assert.equal(error.availableCredits, 15)

    const fakeClient = path.join(dir, 'region.cjs')
    await fs.writeFile(fakeClient, "console.log(JSON.stringify({task_id:'test-task'}))")
    Object.assign(config.tencent, {
      python: process.execPath, regionScript: fakeClient, bucket: 'test', region: 'test',
      mpsRegion: 'test', secretId: 'test', secretKey: 'test',
    })
    config.pollIntervalMs = 60 * 60 * 1000
    config.fullAccessUsers = [userId]
    const otherRegister = await fetch(base + '/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'other@example.com', password: 'password123', confirmPassword: 'password123' }),
    })
    const otherCookie = otherRegister.headers.get('set-cookie').split(';')[0]
    const otherId = (await otherRegister.json()).user.id
    const video = await fs.readFile(videoFile)
    const manualUpload = (userCookie) => fetch(base + '/api/jobs?area=0,0,0.5,0.5&expectedCredits=48', {
      method: 'POST', headers: { cookie: userCookie, 'content-type': 'video/mp4', 'x-filename': 'test.mp4' },
      body: video,
    })
    const insufficient = await manualUpload(otherCookie)
    assert.equal(insufficient.status, 402)
    assert.equal((await insufficient.json()).error.requiredCredits, 48)
    ledger.grantPermanent(otherId, 'one-time-test', 300)
    const oneTimeUpload = await manualUpload(otherCookie)
    assert.equal(oneTimeUpload.status, 201)
    const oneTimeJob = (await oneTimeUpload.json()).job
    assert.equal(ledger.balance(otherId).total, 267)

    const starterRegister = await fetch(base + '/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'starter@example.com', password: 'password123', confirmPassword: 'password123' }),
    })
    const starterCookie = starterRegister.headers.get('set-cookie').split(';')[0]
    const starterId = (await starterRegister.json()).user.id
    const now = Date.now()
    ledger.grantSubscription(starterId, 'starter-test', {
      plan: 'starter', periodId: 'starter-period', periodStart: now - 1000, periodEnd: now + 86400_000,
    })
    const starterUpload = await manualUpload(starterCookie)
    assert.equal(starterUpload.status, 201)
    const starterJob = (await starterUpload.json()).job
    assert.equal(ledger.balance(starterId).total, 567)
    const fullAccount = await fetch(base + '/api/billing/account', { headers: { cookie } })
    assert.equal((await fullAccount.json()).fullAccess, true)
    const fullUpload = await fetch(base + '/api/jobs?area=0,0,0.5,0.5', {
      method: 'POST', headers: { cookie, 'content-type': 'video/mp4', 'x-filename': 'test.mp4' },
      body: await fs.readFile(videoFile),
    })
    assert.equal(fullUpload.status, 201)
    const fullJob = (await fullUpload.json()).job
    assert.equal(fullJob.mode, 'box')
    assert.equal(store.get(fullJob.id).billable, false)
    assert.equal(ledger.balance(userId).total, 15)
    assert.equal(ledger.pendingReservations().filter((reservation) => reservation.user_id === userId).length, 0)
    for (let i = 0; i < 100 && [fullJob, oneTimeJob, starterJob].some((job) => !store.get(job.id).taskId); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(store.get(fullJob.id).taskId, 'test-task')
    assert.equal(store.get(oneTimeJob.id).taskId, 'test-task')
    assert.equal(store.get(starterJob.id).taskId, 'test-task')
  }
  ledger.createCheckout('order_test', userId, 'onetime')
  const raw = JSON.stringify({ id: 'event1', eventId: 'payment1', timestamp: new Date().toISOString(),
    eventType: 'order.completed', mode: 'test', storeId: 'STO_test',
    data: { orderMerchantExternalId: 'order_test', paymentId: 'payment1', paymentStatus: 'succeeded',
      currency: 'USD', chargedAmount: '2.90' } })
  const timestamp = String(Date.now())
  const signature = crypto.sign('sha256', Buffer.from(`${timestamp}.${raw}`), privateKey).toString('base64')
  const webhook = () => fetch(base + '/api/billing/waffo-webhook', {
    method: 'POST', headers: { 'x-waffo-signature': `t=${timestamp},v1=${signature}` }, body: raw,
  })
  assert.equal((await webhook()).status, 200)
  assert.equal((await webhook()).status, 200)
  const account = await fetch(base + '/api/billing/account', { headers: { cookie } })
  assert.equal((await account.json()).balance.total, 315)
})
