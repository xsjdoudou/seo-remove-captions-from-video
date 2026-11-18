import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

test('analytics sends GA4 events without breaking SSR or the workflow', async (t) => {
  const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false } })
  t.after(() => vite.close())
  const { trackEvent } = await vite.ssrLoadModule('/src/lib/analytics.ts')
  assert.doesNotThrow(() => trackEvent('upload_start'))
  globalThis.window = {}
  t.after(() => { delete globalThis.window })
  assert.doesNotThrow(() => trackEvent('upload_start'))
  const calls = []
  globalThis.window.gtag = (...args) => calls.push(args)
  trackEvent('upload_start', { file_type: 'video/mp4', file_size_mb: 12 })
  trackEvent('process_success')
  assert.deepEqual(calls, [
    ['event', 'upload_start', { file_type: 'video/mp4', file_size_mb: 12 }],
    ['event', 'process_success', {}],
  ])
  globalThis.window.gtag = () => { throw new Error('blocked') }
  assert.doesNotThrow(() => trackEvent('download_click'))
})
