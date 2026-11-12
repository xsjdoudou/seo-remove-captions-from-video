#!/usr/bin/env node
// 加载 .env 之后再执行后面的命令：
//
//   node scripts/with-env.mjs vite
//   node scripts/with-env.mjs node scripts/erase-api.mjs
//
// 存在的意义是让 `npm run dev` 和 `npm run api` 看到同一份配置，
// 不用每个入口各写一遍加载逻辑，也不用把密钥写进 package.json。

import { spawn } from 'node:child_process'
import process from 'node:process'
import { loadEnv, REPO_ROOT } from './env.mjs'

const argv = process.argv.slice(2)
if (argv.length === 0) {
  console.error('usage: node scripts/with-env.mjs <command> [args...]')
  process.exit(2)
}

const applied = loadEnv()
if (applied.length > 0) {
  // 只打键名，值里有密钥。
  console.error(`[with-env] loaded ${applied.length} vars from .env: ${applied.join(', ')}`)
} else {
  console.error('[with-env] no .env applied (missing file, or every key already set in the environment)')
}

const child = spawn(argv[0], argv.slice(1), {
  stdio: 'inherit',
  cwd: REPO_ROOT,
  env: process.env,
  shell: false,
})

child.on('error', (err) => {
  console.error(`[with-env] failed to start ${argv[0]}: ${err.message}`)
  process.exit(1)
})

// 转发信号，否则 Ctrl-C 只杀掉这个壳，子进程变孤儿继续占着端口。
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
