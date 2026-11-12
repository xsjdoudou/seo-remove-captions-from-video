// 后端配置：把 process.env 收敛成一个校验过的对象。
//
// 全部读取集中在这里，别处不再碰 process.env。启动时就把配置错误喊出来，
// 比等到用户传完 600MB 视频才发现桶名拼错强。

import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, loadEnv } from './env.mjs'

// 直接 `vite` 启动（没过 with-env.mjs）时也要能读到配置。loadEnv 不覆盖
// 已存在的变量，所以重复调用是安全的。
loadEnv()

// 和 tencent_smart_erase.py 里的 BUCKET_OR_REGION 保持一致。
const BUCKET_OR_REGION = /^[a-z0-9-]+$/

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = (process.env[name] ?? '').trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`)
  }
  return value
}

function str(name, fallback = '') {
  return (process.env[name] ?? '').trim() || fallback
}

/** 去掉末尾斜杠，方便后面统一用 `${base}/path` 拼接。 */
function trimBase(value) {
  return value.replace(/\/+$/, '')
}

export function loadConfig() {
  const dataDir = path.resolve(REPO_ROOT, str('DATA_DIR', './data'))

  const bucket = str('TENCENT_COS_BUCKET')
  const region = str('TENCENT_COS_REGION')
  const secretId = str('TENCENT_SECRET_ID')
  const secretKey = str('TENCENT_SECRET_KEY')

  // 凭证缺失不在这里抛错：没有密钥时网站本身仍应该能起来（落地页、文档、
  // 健康检查都不需要腾讯云），只是提交任务会失败。把这个状态显式带出去，
  // 让 /api/config 能告诉前端"当前不可用"，而不是让用户传完才报错。
  const tencentReady = Boolean(secretId && secretKey && bucket && region)
  if (bucket && !BUCKET_OR_REGION.test(bucket)) {
    throw new Error('TENCENT_COS_BUCKET must contain only lowercase letters, digits, and hyphens')
  }
  if (region && !BUCKET_OR_REGION.test(region)) {
    throw new Error('TENCENT_COS_REGION must contain only lowercase letters, digits, and hyphens')
  }

  const sourcePublicBase = trimBase(str('SOURCE_PUBLIC_BASE'))
  if (sourcePublicBase && !/^https?:\/\//.test(sourcePublicBase)) {
    throw new Error('SOURCE_PUBLIC_BASE must start with http:// or https://')
  }

  const config = {
    repoRoot: REPO_ROOT,
    apiPort: int('API_PORT', 10060, { min: 1, max: 65535 }),
    // 默认只监听回环。生产是 nginx 在前面转发，后端没有理由直接暴露在公网上
    // ——它上面没有 TLS，限流也依赖 nginx 传来的真实 IP。
    // 要裸跑才改成 0.0.0.0，并且记得同时把 TRUST_PROXY 关掉。
    apiHost: str('API_HOST', '127.0.0.1'),
    dataDir,
    sourceDir: path.join(dataDir, 'sources'),
    resultDir: path.join(dataDir, 'results'),
    jobsFile: path.join(dataDir, 'jobs.json'),

    publicBase: trimBase(str('PUBLIC_BASE')),
    sourcePublicBase,

    maxUploadBytes: int('MAX_UPLOAD_BYTES', 600 * 1024 * 1024, { min: 1024 }),
    maxDurationSeconds: int('MAX_DURATION_SECONDS', 900, { min: 0 }),
    retentionMs: int('RETENTION_MS', 24 * 60 * 60 * 1000, { min: 60_000 }),
    rateLimitConcurrent: int('RATE_LIMIT_CONCURRENT', 2, { min: 1 }),
    rateLimitDaily: int('RATE_LIMIT_DAILY', 10, { min: 1 }),
    // 生产环境站在 nginx/caddy 后面时打开，否则所有请求的来源 IP 都会是
    // 127.0.0.1，限流等于形同虚设。直接裸奔在公网时必须关着,
    // 不然任何人伪造一个 X-Forwarded-For 就能绕过限流。
    trustProxy: str('TRUST_PROXY', 'false').toLowerCase() === 'true',
    pollIntervalMs: int('POLL_INTERVAL_MS', 5000, { min: 1000 }),
    jobTimeoutMs: int('JOB_TIMEOUT_MS', 60 * 60 * 1000, { min: 60_000 }),

    tencent: {
      ready: tencentReady,
      secretId,
      secretKey,
      bucket,
      region,
      mpsRegion: str('TENCENT_MPS_REGION', 'ap-guangzhou'),
      definition: int('TENCENT_DEFINITION', 101, { min: 1 }),
      python: str('TENCENT_PYTHON', 'python3'),
      script: path.join(REPO_ROOT, 'scripts', 'tencent_smart_erase.py'),
      // 框选模式走另一个脚本：它提交的是 SubtitleEraseMethod=custom + CustomAreas，
      // 和自动模式不是同一套参数。两个脚本必须放在同一个目录——
      // region 脚本 `from tencent_smart_erase import ...`，靠的是脚本自身所在目录。
      regionScript: path.join(REPO_ROOT, 'scripts', 'tencent_smart_erase_region.py'),
    },
  }

  if (config.jobTimeoutMs <= config.pollIntervalMs) {
    throw new Error('JOB_TIMEOUT_MS must be larger than POLL_INTERVAL_MS')
  }
  if (config.tencent.ready && !fs.existsSync(config.tencent.script)) {
    throw new Error(`missing SmartErase client script: ${config.tencent.script}`)
  }
  if (config.tencent.ready && !fs.existsSync(config.tencent.regionScript)) {
    throw new Error(`missing SmartErase region client script: ${config.tencent.regionScript}`)
  }

  return config
}

/** 启动时打印一份不含密钥的配置摘要，方便排障。 */
export function describeConfig(config) {
  const lines = [
    `data dir            ${config.dataDir}`,
    `max upload          ${(config.maxUploadBytes / 1024 / 1024).toFixed(0)} MB`,
    `max duration        ${config.maxDurationSeconds || 'unlimited'} s`,
    `retention           ${(config.retentionMs / 3600_000).toFixed(1)} h`,
    `rate limit          ${config.rateLimitConcurrent} concurrent / ${config.rateLimitDaily} per day per IP`,
    `tencent credentials ${config.tencent.ready ? 'present' : 'MISSING — submissions will fail'}`,
    `cos output          ${config.tencent.bucket || '(unset)'} @ ${config.tencent.region || '(unset)'}`,
    `source public base  ${config.sourcePublicBase || '(unset — MPS cannot reach localhost, submissions will fail)'}`,
  ]
  return lines.map((line) => `  ${line}`).join('\n')
}
