#!/usr/bin/env node
// 部署自检：在把站点放出去之前，确认这条链路真的能通。
//
//   npm run check:tencent
//
// 依次检查：
//   1. 配置是否齐全（密钥、桶、公网地址）
//   2. ffprobe 在不在（不在的话时长限制会失效）
//   3. SOURCE_PUBLIC_BASE 是不是真的从公网能取到本机的文件
//   4. 腾讯云的凭证是否有效
//
// 第 3 条是最容易出事的一环：本机 curl 得通不代表腾讯云取得到——
// 防火墙、安全组、只监听 127.0.0.1，每一个都会让任务停在
// "下载源文件失败" 上，而那个报错里看不出原因。

import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

import { loadConfig, describeConfig } from './config.mjs'

let failures = 0

function pass(message) {
  console.log(`  \x1b[32m✓\x1b[0m ${message}`)
}

function fail(message, hint) {
  failures += 1
  console.log(`  \x1b[31m✗\x1b[0m ${message}`)
  if (hint) console.log(`    ↳ ${hint}`)
}

function warn(message, hint) {
  console.log(`  \x1b[33m!\x1b[0m ${message}`)
  if (hint) console.log(`    ↳ ${hint}`)
}

const config = loadConfig()
console.log('\nConfiguration')
console.log(describeConfig(config))

console.log('\nChecks')

// 1. 配置
if (config.tencent.secretId && config.tencent.secretKey) {
  pass('Tencent credentials are set')
} else {
  fail('TENCENT_SECRET_ID / TENCENT_SECRET_KEY are missing', 'copy .env.example to .env and fill them in')
}

if (config.sourcePublicBase) {
  pass(`SOURCE_PUBLIC_BASE is ${config.sourcePublicBase}`)
  if (/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)/.test(config.sourcePublicBase)) {
    fail(
      'SOURCE_PUBLIC_BASE points at localhost',
      'Tencent MPS fetches the source video from its own network — localhost there is its own machine, not yours',
    )
  }
} else {
  fail('SOURCE_PUBLIC_BASE is empty', 'without it the backend cannot hand Tencent a URL it can fetch')
}

// 2. ffprobe
await new Promise((resolve) => {
  execFile('ffprobe', ['-version'], { timeout: 10_000 }, (err) => {
    if (err) warn('ffprobe not found', 'duration limits will be skipped; install ffmpeg to enforce MAX_DURATION_SECONDS')
    else pass('ffprobe is available')
    resolve()
  })
})

// 3. 公网可达性：往 sources 目录丢一个探针文件，然后从公网地址取回来。
if (config.sourcePublicBase) {
  const token = crypto.randomBytes(12).toString('hex')
  const probePath = path.join(config.sourceDir, `${token}.mp4`)
  const body = `probe-${token}`
  await fsp.mkdir(config.sourceDir, { recursive: true })
  await fsp.writeFile(probePath, body)
  try {
    // 注意：这要求 erase-api 已经在跑，而且这个 token 对应的任务存在才会被发出去。
    // 所以这里只检查"地址通不通"，拿到 404 也算网络是通的。
    const url = `${config.sourcePublicBase}/s/${token}.mp4`
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (response.status === 404) {
      pass(`${config.sourcePublicBase} is reachable (404 for an unknown token is expected)`)
    } else if (response.ok) {
      pass(`${config.sourcePublicBase} is reachable and serving files`)
    } else {
      warn(`${url} returned HTTP ${response.status}`, 'the host answered, but check that /s/ is not behind auth')
    }
  } catch (err) {
    fail(
      `could not reach ${config.sourcePublicBase}`,
      `${err.message} — is erase-api running, is nginx forwarding /s/, and is the port open to the internet?`,
    )
  } finally {
    await fsp.rm(probePath, { force: true })
  }
}

// 4. 凭证有效性：查一个不存在的任务 id。凭证错会报签名/鉴权失败，
//    凭证对会报任务不存在——后者正是我们想看到的。
if (config.tencent.ready) {
  const { queryTask } = await import('./tencent.mjs')
  try {
    await queryTask(config, '0000000000-procedurev2-0000000000000000000000000000')
    pass('Tencent MPS accepted the request')
  } catch (err) {
    const message = String(err.message)
    if (/AuthFailure|SignatureFailure|SecretId/i.test(message)) {
      fail('Tencent rejected the credentials', message.slice(0, 300))
    } else if (/InvalidParameter|ResourceNotFound|not exist|TaskId/i.test(message)) {
      pass('Tencent credentials are valid (it rejected the fake task id, as expected)')
    } else {
      warn('Tencent returned an unexpected error', message.slice(0, 300))
    }
  }
}

console.log('')
if (failures > 0) {
  console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m Fix these before pointing the domain at this server.\n`)
  process.exit(1)
}
console.log('\x1b[32mAll checks passed.\x1b[0m\n')
