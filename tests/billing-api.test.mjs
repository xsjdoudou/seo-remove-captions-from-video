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
  for (let i = 0; i < 2; i++) {
    const response = await fetch(base + '/api/billing/account', { headers: { cookie } })
    assert.equal((await response.json()).balance.total, 15)
  }
  const manual = await fetch(base + '/api/jobs?area=0,0,0.5,0.5', { method: 'POST', headers: { cookie } })
  assert.equal(manual.status, 403)
  assert.equal((await manual.json()).error.code, 'plan_required')
  const videoFile = path.join(dir, 'test.mp4')
  const ffmpeg = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=16x16:rate=1',
    '-t', '16', '-c:v', 'mpeg4', '-y', videoFile])
  if (ffmpeg.error?.code !== 'ENOENT') {
    assert.equal(ffmpeg.status, 0, ffmpeg.stderr?.toString())
    const upload = await fetch(base + '/api/jobs', {
      method: 'POST', headers: { cookie, 'content-type': 'video/mp4', 'x-filename': 'test.mp4' },
      body: await fs.readFile(videoFile),
    })
    assert.equal(upload.status, 402)
    const { error } = await upload.json()
    assert.equal(error.code, 'insufficient_credits')
    assert.equal(error.requiredCredits, 16)
    assert.equal(error.availableCredits, 15)
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
