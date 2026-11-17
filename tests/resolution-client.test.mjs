import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { transformWithEsbuild } from 'vite'
import { creditCost, resolutionMultiplier } from '../scripts/credits.mjs'

async function loadTs(relative) {
  const file = fileURLToPath(new URL(relative, import.meta.url))
  const { code } = await transformWithEsbuild(await fs.readFile(file, 'utf8'), file, { loader: 'ts', format: 'esm' })
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

let resolution
let api
before(async () => {
  resolution = await loadTs('../src/lib/resolution.ts')
  api = await loadTs('../src/lib/api.ts')
})

test('browser estimates match server resolution and mode pricing', () => {
  for (const [width, height] of [[1280, 720], [1920, 1080], [2160, 3840], [720, 1280]]) {
    for (const mode of ['auto', 'box']) {
      for (const output of ['original', '720']) {
        const video = { width, height, duration: 10.1 }
        assert.equal(resolution.estimateCredits(video, mode, output),
          creditCost(video.duration, mode, resolutionMultiplier(width, height, output)))
      }
    }
  }
})

test('upload sends the chosen resolution, confirmed cost, and box coordinates', async (t) => {
  const previous = globalThis.XMLHttpRequest
  let request
  globalThis.XMLHttpRequest = class {
    constructor() {
      request = this
      this.upload = { addEventListener() {} }
      this.events = {}
    }
    open(method, url) { this.method = method; this.url = url }
    setRequestHeader() {}
    addEventListener(name, callback) { this.events[name] = callback }
    send() {
      this.status = 201
      this.responseText = JSON.stringify({ job: { id: 'test' } })
      this.events.load()
    }
  }
  t.after(() => { globalThis.XMLHttpRequest = previous })
  const { promise } = api.uploadVideo({ type: 'video/mp4', name: 'test.mp4' }, {
    areas: [[0.1, 0.2, 0.5, 0.6]], resolution: '720', expectedCredits: 33,
  })
  await promise
  const url = new URL(request.url, 'https://example.com')
  assert.equal(request.method, 'POST')
  assert.equal(url.searchParams.get('resolution'), '720')
  assert.equal(url.searchParams.get('expectedCredits'), '33')
  assert.deepEqual(url.searchParams.getAll('area'), ['0.1,0.2,0.5,0.6'])
})
