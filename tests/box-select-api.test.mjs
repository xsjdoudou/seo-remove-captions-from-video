import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { loadConfig } from '../scripts/config.mjs'
import { createHandler } from '../scripts/erase-api.mjs'

test('box upload passes selected areas through to the region processing client', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'box-select-'))
  const output = path.join(dir, 'args.json')
  const fakeClient = path.join(dir, 'region.cjs')
  await fs.writeFile(fakeClient, `
    const fs = require('node:fs')
    fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)))
    console.log(JSON.stringify({ task_id: 'test-task' }))
  `)
  const defaults = loadConfig()
  const config = {
    ...defaults,
    dataDir: dir,
    sourceDir: path.join(dir, 'sources'),
    resultDir: path.join(dir, 'results'),
    jobsFile: path.join(dir, 'jobs.json'),
    usersFile: path.join(dir, 'users.json'),
    sourcePublicBase: 'https://example.com',
    pollIntervalMs: 60 * 60 * 1000,
    billing: { enabled: false },
    tencent: {
      ...defaults.tencent,
      ready: true,
      python: process.execPath,
      regionScript: fakeClient,
      bucket: 'test-bucket',
      region: 'test-region',
      mpsRegion: 'test-region',
      secretId: 'test',
      secretKey: 'test',
    },
  }
  const { handler, store, users } = await createHandler(config)
  const server = http.createServer((req, res) => void handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await Promise.all([store.flush(), users.flush()])
    await fs.rm(dir, { recursive: true, force: true })
  })

  const query = new URLSearchParams()
  query.append('area', '0.1,0.2,0.5,0.6')
  query.append('area', '0.6,0.7,0.99999,0.99999')
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/jobs?${query}`, {
    method: 'POST',
    headers: { 'content-type': 'video/mp4', 'x-filename': 'test.mp4' },
    body: Buffer.from('test video'),
  })
  assert.equal(response.status, 201)
  const { job } = await response.json()
  assert.equal(job.mode, 'box')
  assert.deepEqual(store.get(job.id).areas, [[0.1, 0.2, 0.5, 0.6], [0.6, 0.7, 0.9999, 0.9999]])

  let args
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      args = JSON.parse(await fs.readFile(output, 'utf8'))
      break
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  assert.ok(args, 'region client was not called')
  assert.ok(args.includes('--unit'))
  assert.equal(args[args.indexOf('--unit') + 1], 'percent')
  const areas = args.flatMap((arg, index) => arg === '--area' ? [args.slice(index + 1, index + 5).map(Number)] : [])
  assert.deepEqual(areas, [[0.1, 0.2, 0.5, 0.6], [0.6, 0.7, 0.9999, 0.9999]])
})
