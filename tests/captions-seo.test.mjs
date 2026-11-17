import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

test('captions page renders its tool, links, metadata and matching FAQ without a browser', async (t) => {
  const vite = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true } })
  t.after(() => vite.close())
  const { render, ROUTES, metaFor, siteSchema } = await vite.ssrLoadModule('/src/entry-server.tsx')
  const route = '/remove-captions-from-video'
  const { CAPTIONS_FAQ } = await vite.ssrLoadModule('/src/seo.ts')
  const meta = metaFor(route)
  const html = render(route)

  assert.ok(ROUTES.includes(route))
  assert.equal(meta.title, 'Remove Captions From Video — Erase Burned-In Captions Online')
  assert.ok(meta.title.length <= 60)
  assert.ok(meta.description.length >= 120 && meta.description.length <= 160)
  assert.equal(meta.image, 'https://removetextfromvideo.io/demo/auto-after.jpg')
  assert.ok(html.includes('<h1 class="hero__title">Remove captions from video</h1>'))
  assert.ok(html.includes('id="tool"'))
  assert.ok(html.includes('href="/remove-subtitles-from-video"'))
  assert.ok(html.includes('href="/#video-tools"'))
  assert.equal(CAPTIONS_FAQ.length, 5)
  const faqSchema = meta.schema.find((item) => item['@type'] === 'FAQPage')
  for (const [index, item] of CAPTIONS_FAQ.entries()) {
    assert.ok(html.includes(item.q))
    assert.ok(html.includes(item.a))
    assert.equal(faqSchema.mainEntity[index].name, item.q)
    assert.equal(faqSchema.mainEntity[index].acceptedAnswer.text, item.a)
  }
  assert.equal(meta.schema.filter((item) => item['@type'] === 'BreadcrumbList').length, 1)
  const software = siteSchema(route).filter((item) => item['@type'] === 'SoftwareApplication')
  assert.equal(software.length, 1)
  assert.equal(software[0].url, `https://removetextfromvideo.io${route}`)
  assert.equal(software[0].description, meta.description)
})
