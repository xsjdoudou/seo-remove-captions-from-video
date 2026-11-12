// 读取仓库根目录的 .env，填进 process.env。
//
// 不用 dotenv 依赖：这里只需要 `KEY=value` 这一种语法，自己解析二十行就够了，
// 少一个依赖就少一处供应链风险——这个进程手里拿着腾讯云密钥。
//
// 语义和 `node --env-file` 对齐：**已经存在的环境变量优先**，所以
// `API_PORT=10061 npm run api` 这种临时覆盖不用改文件。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 解析 dotenv 文本。返回插入顺序的 [key, value] 列表。 */
export function parseEnv(text) {
  const out = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    // 引号包裹的值去掉引号；双引号里还原 \n，和 dotenv 一致。
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      const quote = value[0]
      value = value.slice(1, -1)
      if (quote === '"') value = value.replace(/\\n/g, '\n')
    }
    out.push([key, value])
  }
  return out
}

/** 把 .env 加载进 process.env，返回本次新填入的键名。 */
export function loadEnv(file = path.join(REPO_ROOT, '.env')) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const applied = []
  for (const [key, value] of parseEnv(text)) {
    if (process.env[key] !== undefined) continue
    process.env[key] = value
    applied.push(key)
  }
  return applied
}
