import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

const nginxAvailable = spawnSync('nginx', ['-v'], { stdio: 'ignore' }).status === 0

test('nginx redirects page trailing slashes without redirect loops', { skip: !nginxAvailable }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nginx-routes-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const source = await fsp.readFile(new URL('../deploy/nginx.conf.example', import.meta.url), 'utf8')
  const redirect = source.match(/location ~ \^\/\(how-it-works\|pricing\|privacy\|terms\)\/\$ \{[^}]*\}/)?.[0]
  const staticLocation = source.match(/location \/ \{[^}]*\}/)?.[0]
  assert.ok(redirect)
  assert.ok(staticLocation)

  await fsp.mkdir(path.join(dir, 'how-it-works'))
  await fsp.writeFile(path.join(dir, 'how-it-works', 'index.html'), 'How it works')
  await fsp.writeFile(path.join(dir, 'index.html'), 'Home')
  const socket = net.createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))

  const config = `pid ${dir}/nginx.pid;
error_log ${dir}/error.log;
events {}
http {
  access_log off;
  server {
    listen 127.0.0.1:${port};
    root ${dir};
    ${redirect}
    ${staticLocation}
  }
}`
  const configFile = path.join(dir, 'nginx.conf')
  await fsp.writeFile(configFile, config)
  const nginx = spawn('nginx', ['-c', configFile, '-g', 'daemon off;'], { stdio: 'ignore' })
  t.after(async () => {
    nginx.kill('SIGTERM')
    if (nginx.exitCode === null) await once(nginx, 'exit')
  })
  const base = `http://127.0.0.1:${port}`
  let response
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      response = await fetch(`${base}/how-it-works/?source=test`, { redirect: 'manual' })
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  assert.ok(response, 'nginx did not start')
  assert.equal(response.status, 301)
  assert.equal(new URL(response.headers.get('location'), base).pathname, '/how-it-works')
  assert.equal(new URL(response.headers.get('location'), base).search, '?source=test')

  response = await fetch(`${base}/how-it-works`, { redirect: 'manual' })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'How it works')
  response = await fetch(`${base}/`, { redirect: 'manual' })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'Home')
})
