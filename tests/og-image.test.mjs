import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

test('home, how-it-works and pricing share an existing social image', async (t) => {
  const vite = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false } })
  t.after(() => vite.close())
  const { metaFor } = await vite.ssrLoadModule('/src/seo.ts')
  for (const route of ['/', '/how-it-works', '/pricing']) {
    assert.equal(metaFor(route).image, 'https://removetextfromvideo.io/demo/share-comparison.jpg')
  }
  const image = await fs.readFile(new URL('../public/demo/share-comparison.jpg', import.meta.url))
  assert.deepEqual([...image.subarray(0, 3)], [0xff, 0xd8, 0xff])
  assert.equal(metaFor('/privacy').image, undefined)
})
