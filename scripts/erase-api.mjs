// 后端 HTTP 层。
//
// 两种跑法：
//   1. `npm run api` —— 独立进程监听 API_PORT，生产用（nginx 在前面转发）。
//   2. 被 vite.config.ts 当中间件挂进 dev server —— 本地开发只起一个进程。
// 所以这里把路由逻辑做成 createHandler(config) 返回的 (req, res, next)，
// 两种跑法共用同一份代码。
//
// 没有框架依赖：一共七个路由，node:http 够用，少一层依赖就少一处要跟的 CVE。

import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline as streamPipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'

import { loadConfig, describeConfig } from './config.mjs'
import { JobStore, UserStore, ACTIVE_STATUSES } from './store.mjs'
import { Pipeline } from './pipeline.mjs'
import {
  AuthError,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  clearCookie,
  parseCookies,
  readSession,
  serializeCookie,
  signSession,
  userIdForGoogle,
  verifyGoogleIdToken,
  hashPassword,
  verifyPassword,
} from './auth.mjs'
import { sanitizeFilename, videoExtension, contentTypeFor, probeDurationSeconds, ACCEPT_ATTRIBUTE } from './media.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 10 * 60 * 1000
const AUTH_WINDOW_MS = 15 * 60 * 1000

export async function createHandler(config = loadConfig()) {
  await fsp.mkdir(config.sourceDir, { recursive: true })
  await fsp.mkdir(config.resultDir, { recursive: true })

  const store = new JobStore(config.jobsFile)
  await store.load()
  const users = new UserStore(config.usersFile)
  await users.load()
  const authAttempts = new Map()
  const pipeline = new Pipeline(config, store)
  pipeline.resume()

  // 配置不全时在终端里说清楚是缺哪一项。
  // 浏览器上只会看到一句笼统的 "temporarily unavailable"——那是给用户的，
  // 不该暴露服务端配置；但开发和运维的人需要一眼看出原因，否则就得去翻
  // /api/config 猜 ready:false 是哪个条件没满足。
  if (!config.tencent.ready || !config.sourcePublicBase) {
    const missing = []
    if (!config.tencent.secretId || !config.tencent.secretKey) missing.push('TENCENT_SECRET_ID / TENCENT_SECRET_KEY')
    if (!config.tencent.bucket) missing.push('TENCENT_COS_BUCKET')
    if (!config.tencent.region) missing.push('TENCENT_COS_REGION')
    if (!config.sourcePublicBase) missing.push('SOURCE_PUBLIC_BASE')
    console.warn(
      `\n[api] \x1b[33mUploads are disabled\x1b[0m — the browser shows "temporarily unavailable".\n` +
        `      Missing in .env: ${missing.join(', ')}\n` +
        (config.sourcePublicBase
          ? ''
          : `      SOURCE_PUBLIC_BASE must be an address Tencent MPS can GET from the public internet,\n` +
            `      so a dev machine without public ingress cannot run the full flow.\n`) +
        `      Run \`npm run check:tencent\` for a full diagnosis.\n`,
    )
  }

  const sweeper = setInterval(() => void sweep(config, store), SWEEP_INTERVAL_MS)
  sweeper.unref?.()
  void sweep(config, store)

  if (!config.auth.googleClientId) {
    console.warn(
      `[api] \x1b[33mGoogle sign-in is off\x1b[0m — GOOGLE_CLIENT_ID is unset.\n` +
        `      Email sign-in and anonymous access remain available.\n`,
    )
  } else if (!config.auth.cookieSecure) {
    // 这一条在本地是正常的，在生产是个会把会话 cookie 暴露在明文里的事故。
    console.warn('[api] session cookie is not marked Secure — fine on localhost, never on a public site')
  }

  // 进程退出前把内存里的状态落盘，否则刚提交的任务重启后就找不回来了。
  const onExit = () => {
    store.flushSync()
    users.flushSync()
  }
  process.once('exit', onExit)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      onExit()
      process.exit(0)
    })
  }

  const handler = async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost')
    const route = decodeURIComponent(url.pathname)
    // 每个请求都先解一次会话。认不出来就是匿名访客——这是完全合法的状态，
    // 站点的主流程本来就不要求登录。
    const session = currentUser(req, config, users)

    try {
      if (route === '/api/health') return sendJson(res, 200, { ok: true })
      if (route === '/api/config') return sendJson(res, 200, publicConfig(config))

      if (route === '/api/auth/google' && req.method === 'POST') return await signIn(req, res, { config, users })
      if ((route === '/api/auth/register' || route === '/api/auth/login') && req.method === 'POST') {
        return await passwordSignIn(req, res, { config, users, authAttempts, register: route.endsWith('/register') })
      }
      if (route === '/api/auth/session') {
        if (req.method === 'GET') return sendJson(res, 200, { user: publicUser(session) })
        if (req.method === 'DELETE') return signOut(res, config)
        return sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Use GET or DELETE.' } })
      }

      if (route === '/api/jobs' && req.method === 'POST') {
        return await createJob(req, res, { config, store, pipeline, url, session })
      }
      if (route === '/api/jobs' && req.method === 'GET') return listJobs(res, store, config, session)
      if (route === '/api/jobs/claim' && req.method === 'POST') {
        return await claimJobs(req, res, { config, store, session })
      }

      const jobMatch = /^\/api\/jobs\/([0-9a-f]{24})$/.exec(route)
      if (jobMatch) {
        if (req.method === 'GET') return readJob(res, store, jobMatch[1], config, session)
        if (req.method === 'DELETE') return await removeJob(res, store, jobMatch[1], session)
        return sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Use GET or DELETE.' } })
      }

      // /s/ 是给腾讯云 MPS 取源视频的；/r/ 是给浏览器播放和下载成片的。
      const fileMatch = /^\/([sr])\/([0-9a-f]{24})(\.[a-z0-9]{1,5})$/.exec(route)
      if (fileMatch) return await serveJobFile(req, res, store, fileMatch[1], fileMatch[2], url)

      if (route.startsWith('/api/')) {
        return sendJson(res, 404, { error: { code: 'not_found', message: 'No such endpoint.' } })
      }
    } catch (err) {
      console.error(`[api] ${req.method} ${route} failed: ${err?.stack || err}`)
      if (!res.headersSent) {
        return sendJson(res, 500, { error: { code: 'internal_error', message: 'Something went wrong on our side.' } })
      }
      res.end()
      return undefined
    }

    // 不是 API 路由：dev 模式交还给 vite 处理，独立模式就是 404。
    if (next) return next()
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not found')
    return undefined
  }

  return { handler, config, store, users, pipeline }
}

// ── 登录 ────────────────────────────────────────────────────────────────

/**
 * 从请求的 cookie 里认出当前用户。返回 null 表示匿名。
 *
 * 只读 cookie，不碰 Google：ID token 在登录那一刻用过就扔了，之后的凭证是
 * 我们自己签的会话。
 */
export function currentUser(req, config, users) {
  const raw = parseCookies(req.headers?.cookie)[SESSION_COOKIE]
  if (!raw) return null
  const session = readSession(raw, config.auth.sessionSecret)
  if (!session) return null
  // 账号可能已经被删掉了（用户自己注销，或清理过期账号）。签名有效不等于
  // 这个人还存在，所以必须回表确认一次。
  const user = users.touch(session.userId)
  if (!user) return null
  return user
}

/** 给浏览器看的用户资料。内部字段（createdAt 之外的时间戳）不外发。 */
function publicUser(user) {
  if (!user) return null
  return { id: user.id, email: user.email ?? '', name: user.name ?? '', picture: user.picture ?? '' }
}

async function passwordSignIn(req, res, { config, users, authAttempts, register }) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    return sendJson(res, 415, { error: { code: 'bad_request', message: 'Expected JSON.' } })
  }
  const now = Date.now()
  for (const [key, value] of authAttempts) if (value.reset <= now) authAttempts.delete(key)
  const ip = clientIp(req, config)
  let attempts = authAttempts.get(ip)
  if (!attempts) {
    if (authAttempts.size >= 10000) return sendJson(res, 429, { error: { code: 'rate_limit', message: 'Please try again later.' } })
    attempts = { count: 0, reset: now + AUTH_WINDOW_MS }
    authAttempts.set(ip, attempts)
  }
  if (++attempts.count > 20) return sendJson(res, 429, { error: { code: 'rate_limit', message: 'Too many attempts. Please try again later.' } })
  let body
  try {
    body = await readJsonBody(req)
  } catch {
    return sendJson(res, 400, { error: { code: 'bad_request', message: 'Could not read the request.' } })
  }
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 200) {
    return sendJson(res, 400, { error: { code: 'invalid_credentials', message: 'Enter a valid email and a password between 8 and 200 characters.' } })
  }
  if (register && password !== body?.confirmPassword) {
    return sendJson(res, 400, { error: { code: 'password_mismatch', message: 'Passwords do not match.' } })
  }
  let user
  if (register) {
    const passwordHash = await hashPassword(password)
    user = users.createPasswordAccount(email, passwordHash)
    if (!user) return sendJson(res, 409, { error: { code: 'account_exists', message: 'An email account already exists. Sign in instead.' } })
  } else {
    user = users.findPasswordAccount(email)
    const placeholder = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`
    const valid = await verifyPassword(password, user?.passwordHash ?? placeholder)
    if (!user || !valid) {
      return sendJson(res, 401, { error: { code: 'invalid_credentials', message: 'Email or password is incorrect.' } })
    }
  }
  await users.flush()
  res.setHeader('set-cookie', serializeCookie(SESSION_COOKIE, signSession(user.id, config.auth.sessionSecret), {
    maxAgeMs: SESSION_TTL_MS, secure: config.auth.cookieSecure,
  }))
  return sendJson(res, register ? 201 : 200, { user: publicUser(user) })
}

async function signIn(req, res, { config, users }) {
  if (!config.auth.googleClientId) {
    return sendJson(res, 503, {
      error: { code: 'not_configured', message: 'Sign-in is not available on this server.' },
    })
  }

  let body
  try {
    body = await readJsonBody(req)
  } catch {
    return sendJson(res, 400, { error: { code: 'bad_request', message: 'Could not read the request.' } })
  }

  let profile
  try {
    profile = await verifyGoogleIdToken(body?.credential, { clientId: config.auth.googleClientId })
  } catch (err) {
    if (err instanceof AuthError) {
      // 真实原因留在服务端日志里：浏览器那边只需要知道"这次登录没成"，
      // 具体是 aud 不对还是签名不对，说出去只会帮到正在试探的人。
      console.warn(`[auth] sign-in rejected: ${err.message}`)
      const status = err.code === 'jwks_unavailable' ? 503 : 401
      return sendJson(res, status, {
        error: {
          code: err.code,
          message:
            err.code === 'jwks_unavailable'
              ? 'Could not reach Google to verify your sign-in. Please try again.'
              : 'That sign-in could not be verified. Please try again.',
        },
      })
    }
    throw err
  }

  const userId = userIdForGoogle(profile.sub)
  const user = users.upsert(userId, { email: profile.email, name: profile.name, picture: profile.picture })
  await users.flush()

  res.setHeader(
    'set-cookie',
    serializeCookie(SESSION_COOKIE, signSession(userId, config.auth.sessionSecret), {
      maxAgeMs: SESSION_TTL_MS,
      secure: config.auth.cookieSecure,
    }),
  )
  console.log(`[auth] ${userId} signed in`)
  return sendJson(res, 200, { user: publicUser(user) })
}

/**
 * 登出。
 *
 * 只删 cookie，不动任何任务记录——用户下次登录回来，历史应该还在。
 * 会话是签名式的，服务端没有可以作废的那一份。
 */
function signOut(res, config) {
  res.setHeader('set-cookie', clearCookie(SESSION_COOKIE, { secure: config.auth.cookieSecure }))
  return sendJson(res, 200, { user: null })
}

/**
 * 读 JSON 请求体。
 *
 * 上限很小：这里只收一个 ID token 或一组任务 id，不是上传通道。
 * 没有上限的话，任何人都能用一个无尽的请求体把内存吃光。
 */
async function readJsonBody(req, limitBytes = 16 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// ── 路由实现 ────────────────────────────────────────────────────────────

function publicConfig(config) {
  return {
    // 凭证没配好时前端直接把上传区置灰，而不是让用户传完 500MB 才看到报错。
    ready: config.tencent.ready && Boolean(config.sourcePublicBase),
    maxUploadBytes: config.maxUploadBytes,
    maxDurationSeconds: config.maxDurationSeconds,
    accept: ACCEPT_ATTRIBUTE,
    retentionHours: Math.round(config.retentionMs / 3600_000),
    historyDays: Math.round(config.recordRetentionMs / 86_400_000),
    // client id 本来就是公开信息（它会出现在前端发给 Google 的请求里）。
    // 从这里下发而不是编译进 JS：换一个 Google 项目不用重新构建前端。
    googleClientId: config.auth.googleClientId,
  }
}

async function createJob(req, res, { config, store, pipeline, url, session }) {
  if (!config.tencent.ready || !config.sourcePublicBase) {
    return sendJson(res, 503, {
      error: { code: 'not_configured', message: 'The service is not configured yet. Please try again later.' },
    })
  }

  // 框选区域走查询串而不是请求体：请求体从第一个字节起就是视频本身，
  // 后端直接 pipe 进磁盘，不解析任何结构。放进 URL 还有个好处是出问题时
  // 能在访问日志里直接看到用户画的是哪几个框。
  let areas
  try {
    areas = parseAreas(url.searchParams.getAll('area'))
  } catch (err) {
    return sendJson(res, 400, { error: { code: 'bad_area', message: err.message } })
  }
  const mode = areas.length > 0 ? 'box' : 'auto'

  const ip = clientIp(req, config)
  const limit = checkRateLimit({ store, pipeline, config, ip, userId: session?.id ?? null })
  if (limit) return sendJson(res, 429, { error: limit })

  // 前端把文件名 encodeURIComponent 过了：HTTP 头只能装 latin-1，
  // 中文、emoji 文件名直接塞进去会被截断或报错。
  const filename = sanitizeFilename(decodeHeader(req.headers['x-filename']) || 'video.mp4')
  const extension = videoExtension(filename)
  if (!extension) {
    return sendJson(res, 415, {
      error: { code: 'unsupported_format', message: `Unsupported file type. Accepted: ${ACCEPT_ATTRIBUTE}` },
    })
  }

  // Content-Length 只是个声明，不可信，但它便宜：能提前挡掉绝大多数超限上传，
  // 省下把 600MB 写进磁盘再删掉的功夫。真正的上限在下面边写边数。
  const declared = Number(req.headers['content-length'] || 0)
  if (declared && declared > config.maxUploadBytes) {
    return sendJson(res, 413, { error: { code: 'too_large', message: tooLargeMessage(config) } })
  }

  const job = store.create({
    status: 'uploading',
    filename,
    extension,
    ip,
    // 登录用户的任务挂在账号上，换台设备也能列出来；匿名任务的 userId 是
    // null，它的历史只存在于提交它的那台浏览器里。
    userId: session?.id ?? null,
    bytes: 0,
    mode,
    areas: areas.length > 0 ? areas : null,
    taskId: null,
    sourcePath: null,
    resultPath: null,
  })
  const target = path.join(config.sourceDir, `${job.token}${extension}`)

  let received = 0
  try {
    await streamPipeline(
      req,
      async function* (source) {
        for await (const chunk of source) {
          received += chunk.length
          if (received > config.maxUploadBytes) {
            const err = new Error('upload exceeded the size limit')
            err.code = 'TOO_LARGE'
            throw err
          }
          yield chunk
        }
      },
      createWriteStream(target, { mode: 0o600 }),
    )
  } catch (err) {
    await fsp.rm(target, { force: true }).catch(() => {})
    store.delete(job.id)
    if (err.code === 'TOO_LARGE') {
      return sendJson(res, 413, { error: { code: 'too_large', message: tooLargeMessage(config) } })
    }
    // 客户端中途断开是常事（用户按了取消），不值得当错误记一条日志。
    if (!res.headersSent) {
      return sendJson(res, 400, { error: { code: 'upload_failed', message: 'The upload did not complete.' } })
    }
    res.end()
    return undefined
  }

  if (received === 0) {
    await fsp.rm(target, { force: true }).catch(() => {})
    store.delete(job.id)
    return sendJson(res, 400, { error: { code: 'empty_file', message: 'The uploaded file was empty.' } })
  }

  // 时长校验放在写盘之后：ffprobe 要有完整文件才量得准。
  const duration = await probeDurationSeconds(target)
  if (config.maxDurationSeconds && duration && duration > config.maxDurationSeconds) {
    await fsp.rm(target, { force: true }).catch(() => {})
    store.delete(job.id)
    return sendJson(res, 413, {
      error: {
        code: 'too_long',
        message: `This video is ${Math.round(duration)}s long. The limit is ${config.maxDurationSeconds}s.`,
      },
    })
  }

  store.update(job.id, { status: 'queued', bytes: received, sourcePath: target, durationSeconds: duration })
  pipeline.start(job.id)
  await store.flush()

  return sendJson(res, 201, { job: serializeJob(store.get(job.id), config) })
}

/**
 * 归属校验。
 *
 * 任务 id 是 96 位随机值，拿到它本身已经是一种凭证（跟那些一次性文件链接
 * 同源的设计）。但一旦任务挂到了账号上，这个凭证就不再是唯一的依据——
 * 别人就算猜到了 id，也不该看到我账号下的东西。匿名任务保持原样：
 * 没有归属可查，有 id 就是有权。
 */
function mayAccess(job, session) {
  if (!job.userId) return true
  return session?.id === job.userId
}

function readJob(res, store, id, config, session) {
  const job = store.get(id)
  // 无权访问和不存在回同一个 404：区分开来等于告诉探测者"这个 id 是真的"。
  if (!job || !mayAccess(job, session)) {
    return sendJson(res, 404, { error: { code: 'not_found', message: 'This job no longer exists.' } })
  }
  return sendJson(res, 200, { job: serializeJob(job, config) })
}

/** 当前登录用户的任务，新的在前。匿名访客拿到空列表，不是 401。 */
function listJobs(res, store, config, session) {
  if (!session) return sendJson(res, 200, { jobs: [], total: 0, signedIn: false })
  const { jobs, total } = store.listByUser(session.id)
  return sendJson(res, 200, { jobs: jobs.map((job) => serializeJob(job, config)), total, signedIn: true })
}

/**
 * 把匿名时提交的任务认领到刚登录的账号下。
 *
 * 没有这一步，用户的使用路径会很别扭：传完一个视频、觉得好用、然后登录，
 * 结果刚才那个任务反而从历史里消失了。
 *
 * 凭据就是任务 id 本身——它是不可猜测的，而且这些 id 来自调用方自己的
 * localStorage。只认领**还没有主人**的任务：已经挂在别人账号下的，
 * 即使 id 被猜中也不会被夺走。
 */
async function claimJobs(req, res, { config, store, session }) {
  if (!session) return sendJson(res, 401, { error: { code: 'not_signed_in', message: 'Sign in first.' } })

  let body
  try {
    body = await readJsonBody(req)
  } catch {
    return sendJson(res, 400, { error: { code: 'bad_request', message: 'Could not read the request.' } })
  }

  const ids = Array.isArray(body?.ids) ? body.ids : []
  // 一次最多认领一屏的量。前端的本地历史上限本来就只有十几条。
  const claimed = []
  for (const id of ids.slice(0, 50)) {
    if (typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id)) continue
    const job = store.get(id)
    if (!job || job.userId) continue
    store.update(id, { userId: session.id })
    claimed.push(id)
  }
  if (claimed.length > 0) await store.flush()

  const { jobs, total } = store.listByUser(session.id)
  return sendJson(res, 200, {
    claimed: claimed.length,
    jobs: jobs.map((job) => serializeJob(job, config)),
    total,
    signedIn: true,
  })
}

async function removeJob(res, store, id, session) {
  const job = store.get(id)
  if (!job || !mayAccess(job, session)) {
    return sendJson(res, 404, { error: { code: 'not_found', message: 'This job no longer exists.' } })
  }
  for (const file of [job.sourcePath, job.resultPath]) {
    if (file) await fsp.rm(file, { force: true }).catch(() => {})
  }
  store.delete(id)
  await store.flush()
  return sendJson(res, 200, { ok: true })
}

async function serveJobFile(req, res, store, kind, token, url) {
  const job = store.findByToken(token)
  const filePath = kind === 's' ? job?.sourcePath : job?.resultPath
  if (!job || !filePath) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not found')
    return undefined
  }

  let stat
  try {
    stat = await fsp.stat(filePath)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not found')
    return undefined
  }

  const ext = kind === 's' ? job.extension : '.mp4'
  const headers = {
    'content-type': contentTypeFor(ext),
    'accept-ranges': 'bytes',
    // 这些是一次性的能力 URL，缓存它们只会让过期的链接继续被取到。
    'cache-control': 'private, no-store',
    // 结果视频是用户自己的内容，不该被别的站点嵌进去。
    'x-content-type-options': 'nosniff',
  }

  if (url.searchParams.get('download') === '1') {
    const name = downloadName(job)
    // filename* 用 RFC 5987 编码，非 ASCII 文件名才不会在这里变成乱码。
    headers['content-disposition'] =
      `attachment; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`
  }

  // Range：浏览器拖动进度条靠它，腾讯云取源视频时也可能用到。
  const range = parseRange(req.headers.range, stat.size)
  if (range === 'invalid') {
    res.writeHead(416, { 'content-range': `bytes */${stat.size}` })
    res.end()
    return undefined
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, { ...headers, 'content-length': String(stat.size) })
    res.end()
    return undefined
  }

  if (range) {
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'content-length': String(range.end - range.start + 1),
    })
    await streamPipeline(fs.createReadStream(filePath, { start: range.start, end: range.end }), res).catch(() => {})
    return undefined
  }

  res.writeHead(200, { ...headers, 'content-length': String(stat.size) })
  await streamPipeline(fs.createReadStream(filePath), res).catch(() => {})
  return undefined
}

// ── 辅助 ────────────────────────────────────────────────────────────────

/**
 * 把内部任务对象转成给浏览器看的形状。
 *
 * 关键在于**白名单**而不是删字段：ip、userId、sourcePath、error.detail 这些
 * 永远不该出现在响应里，而新加字段时白名单是默认安全的那一边。
 */
export function serializeJob(job, config) {
  if (!job) return null
  const base = config?.publicBase ?? ''
  // 登录用户的记录比文件活得久：文件被清掉之后这条记录还在列表里，
  // 状态要变成 expired，否则界面会给出一个必然 404 的下载按钮。
  const purged = Boolean(job.filesPurgedAt)
  const status = purged && job.status === 'completed' ? 'expired' : job.status
  const downloadable = status === 'completed'
  return {
    id: job.id,
    status,
    filename: job.filename,
    mode: job.mode ?? 'auto',
    bytes: job.bytes ?? 0,
    durationSeconds: job.durationSeconds ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    submittedAt: job.submittedAt ?? null,
    completedAt: job.completedAt ?? null,
    expiresAt: job.createdAt + (config?.retentionMs ?? DAY_MS),
    resultUrl: downloadable ? `${base}/r/${job.token}.mp4` : null,
    downloadUrl: downloadable ? `${base}/r/${job.token}.mp4?download=1` : null,
    resultBytes: job.resultBytes ?? null,
    // 只回 code 和给用户看的 message。detail 里可能带着腾讯云的原始报错，
    // 含桶名、账号信息，留在服务端日志里就够了。
    error: job.error ? { code: job.error.code, message: job.error.message } : null,
  }
}

/** 一次最多擦几个框。画到第七个的多半是误操作，而每个框都要进 MPS 的参数里。 */
const MAX_AREAS = 6
/** 框的最小边长（占画面比例）。比这还小的框擦不出东西，多半是手抖点出来的。 */
const MIN_AREA_SIDE = 0.01

/**
 * 解析 ?area=left,top,right,bottom（可重复）。
 *
 * 全部用 0~1 的比例而不是像素：前端量到的本来就是比例，而服务端此刻还没有
 * 视频的真实尺寸（ffprobe 要等文件落盘），换算成像素只能等到更后面，
 * 平白多一处会对不上的地方。
 *
 * 上界取 1 的开区间是腾讯那边的要求（percent 坐标必须落在 [0,1)），
 * 这里提前挡住，不然用户要等到任务提交失败才知道框画到边上了。
 */
export function parseAreas(raw) {
  const list = raw.filter((value) => String(value).trim() !== '')
  if (list.length === 0) return []
  if (list.length > MAX_AREAS) throw new Error(`At most ${MAX_AREAS} boxes can be erased at once.`)

  return list.map((value) => {
    const parts = String(value).split(',').map((part) => Number(part.trim()))
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      throw new Error('Each box must be four numbers: left,top,right,bottom.')
    }
    const [left, top, right, bottom] = parts
    if (parts.some((n) => n < 0 || n >= 1)) {
      throw new Error('Box coordinates must be fractions of the frame, between 0 and 1.')
    }
    if (right - left < MIN_AREA_SIDE || bottom - top < MIN_AREA_SIDE) {
      throw new Error('Each box must be at least 1% of the frame wide and tall.')
    }
    // 统一到小数点后四位：对 4K 来说也还有半个像素的精度，
    // 而原始的浮点尾巴会让同一个框每次提交的参数都不一样。
    return [left, top, right, bottom].map((n) => Math.round(n * 10000) / 10000)
  })
}

/**
 * 限流。
 *
 * 登录用户按账号算，匿名访客按 IP 算。按账号更准：同一个办公室或同一个
 * 运营商 NAT 后面的人共用一个出口 IP，按 IP 算等于让他们互相挤占额度。
 * 额度本身两边一样——登录只是让它算得更准，不是更宽。
 */
function checkRateLimit({ store, pipeline, config, ip, userId }) {
  const owner = userId ? { field: 'userId', value: userId } : { field: 'ip', value: ip }
  if (pipeline.activeCountForOwner(owner) >= config.rateLimitConcurrent) {
    return {
      code: 'too_many_active',
      message: `You already have ${config.rateLimitConcurrent} video(s) processing. Please wait for them to finish.`,
    }
  }
  const since = Date.now() - DAY_MS
  const today = store.list().filter((job) => job[owner.field] === owner.value && job.createdAt >= since).length
  if (today >= config.rateLimitDaily) {
    return {
      code: 'daily_limit',
      message: `You have reached the limit of ${config.rateLimitDaily} videos per day. Please try again tomorrow.`,
    }
  }
  return null
}

/**
 * 请求的来源 IP。
 *
 * 只有在 TRUST_PROXY=true 时才认 X-Forwarded-For——这个头是客户端可以随便写的，
 * 裸奔时信它等于把限流关掉。取最右边那一跳是因为左边的部分同样由客户端控制。
 */
function clientIp(req, config) {
  if (config.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (forwarded.length > 0) return forwarded.at(-1)
  }
  return req.socket.remoteAddress || 'unknown'
}

/** 解 x-filename 的百分号编码。编码坏了就原样返回，交给 sanitizeFilename 兜底。 */
function decodeHeader(value) {
  if (typeof value !== 'string') return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function tooLargeMessage(config) {  return `This file is larger than the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB limit.`
}

/** 下载时的文件名。加后缀是为了不和用户硬盘上的原片重名、互相覆盖。 */
function downloadName(job) {
  const stem = job.filename.replace(/\.[^.]+$/, '') || 'video'
  return `${stem}-no-subtitles.mp4`
}

/** Content-Disposition 的 filename= 必须是 ASCII，非 ASCII 走 filename*。 */
function asciiFallback(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")
  return ascii || 'video-no-subtitles.mp4'
}

/**
 * 解析 Range 请求头。
 *
 * 返回 null 表示"没有 Range，发整个文件"，'invalid' 表示要回 416。
 * 浏览器拖动视频进度条靠它；对 416 和越界的处理错了，表现是进度条拖一下
 * 就卡死，而不是报错，所以这段单独拿出来测。
 */
export function parseRange(header, size) {
  if (!header || size === 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return 'invalid'
  let start
  let end
  if (rawStart === '') {
    // bytes=-500 表示最后 500 字节。
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
  return undefined
}

/**
 * 定期清理。没有这一步，磁盘迟早被塞满。
 *
 * 文件和记录分两个期限：
 *   - 视频文件一律在 RETENTION_MS（默认 24 小时）后删掉，登录与否都一样。
 *     存储成本和隐私承诺都压在这条上，它不因为有账号而放宽。
 *   - 任务**记录**（文件名、时长、状态这些元数据）在登录用户名下保留
 *     RECORD_RETENTION_MS（默认 30 天），这样隔几天回来还能看到自己处理过
 *     什么。匿名任务没有归属，记录跟文件一起清掉——留着它既没人能看到，
 *     又平白多存一份 IP 记录。
 */
async function sweep(config, store) {
  const now = Date.now()
  const fileCutoff = now - config.retentionMs
  const recordCutoff = now - config.recordRetentionMs
  let filesRemoved = 0
  let recordsRemoved = 0

  for (const job of store.list()) {
    const stale = job.createdAt <= fileCutoff
    // 还在跑的任务只要最近有动静就放过：一个跑了 25 小时的任务是异常，
    // 但不该在它正要写结果的时候把源文件抽走。
    const busy = ACTIVE_STATUSES.includes(job.status) && job.updatedAt > fileCutoff

    if (stale && !busy && !job.filesPurgedAt) {
      for (const file of [job.sourcePath, job.resultPath]) {
        if (file) await fsp.rm(file, { force: true }).catch(() => {})
      }
      // 匿名任务到这里就结束了：连记录一起删。
      if (!job.userId) {
        store.delete(job.id)
        recordsRemoved += 1
        filesRemoved += 1
        continue
      }
      // 登录用户的记录留下，但把文件路径抹掉并打上时间戳——serializeJob
      // 据此把状态报成 expired，前端就不会再给出一个必然 404 的下载链接。
      store.update(job.id, { sourcePath: null, resultPath: null, filesPurgedAt: now })
      filesRemoved += 1
      continue
    }

    if (job.userId && job.createdAt <= recordCutoff) {
      store.delete(job.id)
      recordsRemoved += 1
    }
  }

  // 记录和文件可能对不上（比如手工删过 jobs.json），顺手扫一遍孤儿文件。
  for (const dir of [config.sourceDir, config.resultDir]) {
    const entries = await fsp.readdir(dir).catch(() => [])
    for (const entry of entries) {
      const token = entry.replace(/\.[^.]+$/, '')
      const owner = store.findByToken(token)
      // 记录还在但已经标记清过文件的，它的文件同样是孤儿。
      if (owner && !owner.filesPurgedAt) continue
      const file = path.join(dir, entry)
      const stat = await fsp.stat(file).catch(() => null)
      if (stat && stat.mtimeMs < fileCutoff) {
        await fsp.rm(file, { force: true }).catch(() => {})
        filesRemoved += 1
      }
    }
  }

  if (filesRemoved > 0 || recordsRemoved > 0) {
    await store.flush()
    console.log(`[sweep] removed ${filesRemoved} file(s) and ${recordsRemoved} record(s)`)
  }
}

// ── 独立进程入口 ────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`
if (isMain) {
  const config = loadConfig()
  const { handler } = await createHandler(config)
  const server = http.createServer((req, res) => void handler(req, res, null))
  // 上传一个几百 MB 的文件可能要几分钟，默认的 headers/request timeout 会掐断它。
  server.requestTimeout = 0
  server.headersTimeout = 5 * 60 * 1000
  server.listen(config.apiPort, config.apiHost, () => {
    console.log(`[api] listening on http://${config.apiHost}:${config.apiPort}`)
    console.log(describeConfig(config))
  })
}
