import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const nginxAvailable = spawnSync('nginx', ['-v'], { stdio: 'ignore' }).status === 0

test('nginx redirects page trailing slashes without redirect loops', { skip: !nginxAvailable }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nginx-routes-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const source = await fsp.readFile(new URL('../deploy/nginx.conf.example', import.meta.url), 'utf8')
  const redirect = source.match(/location ~ \^\/\(how-it-works\|pricing\|privacy\|terms\|remove-captions-from-video\|remove-subtitles-from-video\|remove-burned-in-subtitles\)\/\$ \{[^}]*\}/)?.[0]
  const staticLocation = source.match(/location \/ \{[^}]*\}/)?.[0]
  assert.ok(redirect)
  assert.ok(staticLocation)

  await fsp.mkdir(path.join(dir, 'how-it-works'))
  await fsp.writeFile(path.join(dir, 'how-it-works', 'index.html'), 'How it works')
  await fsp.mkdir(path.join(dir, 'remove-captions-from-video'))
  await fsp.writeFile(path.join(dir, 'remove-captions-from-video', 'index.html'), 'Captions')
  await fsp.mkdir(path.join(dir, 'remove-subtitles-from-video'))
  await fsp.writeFile(path.join(dir, 'remove-subtitles-from-video', 'index.html'), 'Subtitles')
  await fsp.mkdir(path.join(dir, 'remove-burned-in-subtitles'))
  await fsp.writeFile(path.join(dir, 'remove-burned-in-subtitles', 'index.html'), 'Burned subtitles')
  await fsp.writeFile(path.join(dir, 'index.html'), 'Home')
  const vite = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false } })
  const { renderNotFound } = await vite.ssrLoadModule('/src/entry-server.tsx')
  await fsp.writeFile(path.join(dir, '404.html'), renderNotFound('/assets/test.css'))
  await vite.close()
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
    error_page 404 /404.html;
    location = /404.html { internal; }
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
  response = await fetch(`${base}/remove-captions-from-video/?source=test`, { redirect: 'manual' })
  assert.equal(response.status, 301)
  assert.equal(new URL(response.headers.get('location'), base).pathname, '/remove-captions-from-video')
  assert.equal(new URL(response.headers.get('location'), base).search, '?source=test')
  response = await fetch(`${base}/remove-captions-from-video`, { redirect: 'manual' })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'Captions')
  response = await fetch(`${base}/remove-subtitles-from-video/?source=test`, { redirect: 'manual' })
  assert.equal(response.status, 301)
  assert.equal(new URL(response.headers.get('location'), base).pathname, '/remove-subtitles-from-video')
  assert.equal(new URL(response.headers.get('location'), base).search, '?source=test')
  response = await fetch(`${base}/remove-subtitles-from-video`, { redirect: 'manual' })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'Subtitles')
  response = await fetch(`${base}/remove-burned-in-subtitles/?source=test`, { redirect: 'manual' })
  assert.equal(response.status, 301)
  assert.equal(new URL(response.headers.get('location'), base).pathname, '/remove-burned-in-subtitles')
  assert.equal(new URL(response.headers.get('location'), base).search, '?source=test')
  response = await fetch(`${base}/remove-burned-in-subtitles`, { redirect: 'manual' })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'Burned subtitles')
  response = await fetch(`${base}/`, { redirect: 'manual' })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'Home')
  for (const url of ['/missing-page', '/missing-page/', '/nested/missing', '/missing-image.jpg']) {
    response = await fetch(`${base}${url}`, { redirect: 'manual' })
    assert.equal(response.status, 404, url)
    const body = await response.text()
    assert.match(body, /This page doesn(?:&#x27;|&#39;|')t exist/)
    assert.match(body, /href="\/"/)
    assert.match(body, /<title>Page not found — RemoveTextFromVideo<\/title>/)
    assert.match(body, /<meta name="robots" content="noindex"/)
    assert.match(body, /class="shell"/)
    assert.match(body, /class="navbar"/)
    assert.match(body, /class="footer"/)
    assert.doesNotMatch(body, /<title>Remove Text from Video/)
  }
  response = await fetch(`${base}/missing-page`, { method: 'HEAD' })
  assert.equal(response.status, 404)
  assert.equal(await response.text(), '')
})
