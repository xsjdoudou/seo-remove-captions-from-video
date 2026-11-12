#!/usr/bin/env node
// 手工端到端验证：拿一个**公网可达**的视频地址跑完整条链路。
//
//   node scripts/verify-pipeline.mjs 'https://example.com/input.mp4'
//
// 为什么需要它：开发机通常没有公网入口，/s/ 那个地址腾讯取不到，
// 任务会停在"源文件下载失败"上。这个脚本绕开 /s/，直接用一个已经在公网上的
// 地址，从而验证剩下的每一环：提交、轮询、解析成片地址、把成片拉回本地。
//
// 正式部署之后用 `npm run check:tencent` 验证 /s/ 的公网可达性，两个脚本合起来
// 覆盖完整链路。

import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

import { loadConfig } from './config.mjs'
import { submitTask, queryTask } from './tencent.mjs'

const inputUrl = process.argv[2]
if (!inputUrl) {
  console.error('usage: node scripts/verify-pipeline.mjs <public-video-url>')
  process.exit(2)
}

const config = loadConfig()
if (!config.tencent.ready) {
  console.error('error: Tencent credentials are not configured; fill in .env first')
  process.exit(1)
}

const sessionId = crypto.randomBytes(12).toString('hex')
console.log(`→ submitting ${inputUrl}`)
const taskId = await submitTask(config, { inputUrl, sessionId })
console.log(`  task id: ${taskId}`)

const deadline = Date.now() + config.jobTimeoutMs
let result
while (true) {
  if (Date.now() > deadline) throw new Error('timed out waiting for the task')
  await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs))
  result = await queryTask(config, taskId)
  if (result.status === 'completed') break
  process.stdout.write('.')
}
console.log(`\n→ completed: ${result.path}`)

const target = path.join(config.resultDir, `verify-${sessionId}.mp4`)
await fsp.mkdir(config.resultDir, { recursive: true })
const response = await fetch(result.videoUrl)
if (!response.ok) throw new Error(`downloading the result failed: HTTP ${response.status}`)
await fsp.writeFile(target, Buffer.from(await response.arrayBuffer()))
const stat = await fsp.stat(target)
console.log(`→ downloaded ${(stat.size / 1024 / 1024).toFixed(2)} MB to ${target}`)
console.log('\nPipeline verified.')
