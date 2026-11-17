import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs/promises'

test('subtitles page renders the workspace, metadata, links and matching FAQ', async (t) => {
  const vite = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false } })
  t.after(() => vite.close())
  const { render, ROUTES, metaFor, siteSchema } = await vite.ssrLoadModule('/src/entry-server.tsx')
  const { SUBTITLES_FAQ } = await vite.ssrLoadModule('/src/seo.ts')
  const route = '/remove-subtitles-from-video'
  const meta = metaFor(route)
  const html = render(route)
  assert.ok(ROUTES.includes(route))
  assert.equal(meta.title, 'Remove Subtitles From Video — Erase Hardcoded Subs Online')
  assert.ok(meta.title.length <= 60)
  assert.ok(meta.description.length >= 120 && meta.description.length <= 160)
  assert.ok(html.includes('<h1 class="hero__title">Remove subtitles from video</h1>'))
  assert.ok(html.includes('id="tool"'))
  assert.ok(html.includes('href="/remove-captions-from-video"'))
  assert.ok(html.includes('href="/#video-tools"'))
  assert.doesNotMatch(html, /(?:caption|subtitle) remover/i)
  assert.equal(SUBTITLES_FAQ.length, 5)
  const faq = meta.schema.find((block) => block['@type'] === 'FAQPage')
  for (const [index, item] of SUBTITLES_FAQ.entries()) {
    assert.ok(html.includes(item.q))
    assert.ok(html.includes(item.a))
    assert.equal(faq.mainEntity[index].name, item.q)
    assert.equal(faq.mainEntity[index].acceptedAnswer.text, item.a)
  }
  assert.equal(meta.schema.filter((block) => block['@type'] === 'BreadcrumbList').length, 1)
  const software = siteSchema(route).filter((block) => block['@type'] === 'SoftwareApplication')
  assert.equal(software.length, 1)
  assert.equal(software[0].url, `https://removetextfromvideo.io${route}`)
  assert.equal(software[0].description, meta.description)
  assert.equal(meta.image, 'https://removetextfromvideo.io/demo/auto-after.jpg')
  const image = await fs.readFile(new URL('../public/demo/auto-after.jpg', import.meta.url))
  assert.deepEqual([...image.subarray(0, 3)], [0xff, 0xd8, 0xff])
})
