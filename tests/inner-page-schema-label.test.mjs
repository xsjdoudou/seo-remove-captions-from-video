import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

test('inner pages have a matching workspace label and exactly the required schemas', async (t) => {
  const vite = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true } })
  t.after(() => vite.close())
  const { render, metaFor, siteSchema } = await vite.ssrLoadModule('/src/entry-server.tsx')
  const routes = [
    ['/remove-captions-from-video', 'Remove captions from a video'],
    ['/remove-subtitles-from-video', 'Remove subtitles from a video'],
    ['/remove-burned-in-subtitles', 'Remove burned-in subtitles from a video'],
  ]
  for (const [route, label] of routes) {
    const html = render(route)
    assert.ok(html.includes(`class="workspace" id="tool" aria-label="${label}"`))
    const schema = [...siteSchema(route), ...metaFor(route).schema]
    assert.deepEqual(schema.map((item) => item['@type']).sort(), ['BreadcrumbList', 'FAQPage', 'SoftwareApplication'])
    for (const item of schema.find((block) => block['@type'] === 'FAQPage').mainEntity) {
      assert.ok(html.includes(item.name))
      assert.ok(html.includes(item.acceptedAnswer.text))
    }
  }
  assert.equal(siteSchema('/').filter((item) => item['@type'] === 'WebSite').length, 1)
})
