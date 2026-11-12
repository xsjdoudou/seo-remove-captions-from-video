import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { loadConfig } from '../scripts/config.mjs'
import { createHandler } from '../scripts/erase-api.mjs'

test('password registration, login and account isolation', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rtfv-auth-'))
  const config = {
    ...loadConfig(),
    dataDir: dir, sourceDir: path.join(dir, 'sources'), resultDir: path.join(dir, 'results'),
    jobsFile: path.join(dir, 'jobs.json'), usersFile: path.join(dir, 'users.json'),
    auth: { googleClientId: '', sessionSecret: 'a'.repeat(64), cookieSecure: false },
    tencent: { ready: false },
    sourcePublicBase: '',
  }
  const { handler, users, store } = await createHandler(config)
  const server = http.createServer((req, res) => void handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await Promise.all([users.flush(), store.flush()])
    await fs.rm(dir, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (route, data) => fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  })
  const credentials = { email: 'Test@example.com', password: 'strong-password', confirmPassword: 'different' }
  let response = await post('/api/auth/register', credentials)
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'password_mismatch')
  credentials.confirmPassword = credentials.password
  response = await post('/api/auth/register', credentials)
  assert.equal(response.status, 201)
  const cookie = response.headers.get('set-cookie').split(';')[0]
  const user = (await response.json()).user
  assert.equal(user.email, 'test@example.com')
  assert.equal(user.passwordHash, undefined)
  assert.ok(!JSON.stringify(await fs.readFile(config.usersFile, 'utf8')).includes(credentials.password))
  assert.equal((await post('/api/auth/register', credentials)).status, 409)
  assert.equal((await post('/api/auth/login', { ...credentials, password: 'incorrect' })).status, 401)
  assert.equal((await post('/api/auth/login', credentials)).status, 200)
  response = await fetch(base + '/api/auth/session', { headers: { cookie } })
  assert.equal((await response.json()).user.id, user.id)
  users.upsert('google:123', { email: user.email })
  assert.notEqual(users.get('google:123').id, user.id)
  const mine = store.create({ userId: user.id, status: 'failed', filename: 'mine.mp4' })
  const other = store.create({ userId: 'google:123', status: 'failed', filename: 'other.mp4' })
  response = await fetch(base + '/api/jobs', { headers: { cookie } })
  assert.deepEqual((await response.json()).jobs.map((job) => job.id), [mine.id])
  response = await fetch(base + `/api/jobs/${other.id}`, { headers: { cookie } })
  assert.equal(response.status, 404)
})
