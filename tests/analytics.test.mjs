import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

test('analytics queues GTM custom events without depending on gtag or breaking SSR', async (t) => {
  const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false } })
  t.after(() => vite.close())
  const { trackEvent } = await vite.ssrLoadModule('/src/lib/analytics.ts')
  assert.doesNotThrow(() => trackEvent('upload_start'))
  globalThis.window = {}
  t.after(() => { delete globalThis.window })
  trackEvent('upload_start', { file_type: 'video/mp4', file_size_mb: 12 })
  trackEvent('process_success')
  assert.deepEqual(globalThis.window.dataLayer, [
    { event: 'upload_start', file_type: 'video/mp4', file_size_mb: 12 },
    { event: 'process_success' },
  ])
  globalThis.window.dataLayer = Object.freeze([])
  assert.doesNotThrow(() => trackEvent('download_click'))
})
