import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

test('404 document renders the shared site layout without client JavaScript', async (t) => {
  const vite = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false } })
  t.after(() => vite.close())
  const { renderNotFound, ROUTES } = await vite.ssrLoadModule('/src/entry-server.tsx')
  const html = renderNotFound('/assets/main.css')
  assert.match(html, /<title>Page not found — RemoveTextFromVideo<\/title>/)
  assert.match(html, /<meta name="robots" content="noindex"/)
  assert.match(html, /This page doesn(?:&#x27;|&#39;|')t exist/)
  assert.match(html, /class="shell"/)
  assert.match(html, /class="navbar"/)
  assert.match(html, /class="footer"/)
  assert.match(html, /href="\/"/)
  assert.match(html, /href="\/assets\/main.css"/)
  assert.doesNotMatch(html, /<script/)
  assert.ok(!ROUTES.includes('/404'))
})
