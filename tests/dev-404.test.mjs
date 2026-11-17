import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

test('development server returns real 404s without breaking routes or assets', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-dev-404-'))
  const socket = net.createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    env: { ...process.env, DATA_DIR: dir },
    stdio: 'ignore',
  })
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
    await fs.rm(dir, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${port}`
  let response
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      response = await fetch(`${base}/`)
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  }
  assert.ok(response, 'Vite did not start')
  assert.equal(response.status, 200)
  response = await fetch(`${base}/how-it-works`)
  assert.equal(response.status, 200)
  response = await fetch(`${base}/how-it-works/?test=1`, { redirect: 'manual' })
  assert.equal(response.status, 301)
  assert.equal(response.headers.get('location'), '/how-it-works?test=1')
  for (const url of ['/no-such-page', '/nested/no-such-page/', '/missing.jpg']) {
    response = await fetch(base + url)
    assert.equal(response.status, 404, url)
    if (!url.endsWith('.jpg')) {
      const html = await response.text()
      assert.match(html, /This page doesn(?:&#x27;|&#39;|')t exist/)
      assert.match(html, /href="\/"/)
      assert.match(html, /<meta name="robots" content="noindex"/)
      assert.match(html, /class="footer"/)
    }
  }
  response = await fetch(`${base}/api/health`)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ok, true)
})
