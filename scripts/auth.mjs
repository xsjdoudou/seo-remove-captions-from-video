// 登录：校验 Google 发的 ID token，然后换成我们自己的会话 cookie。
//
// 为什么不用 google-auth-library：它会拖进来十几个传递依赖，而这个进程手里
// 拿着腾讯云密钥，依赖面越小越好。真正要做的事只有两件——按 JWKS 验一个
// RS256 签名，再核对几个声明——Node 自带的 crypto 全都能做。
//
// 流程：
//   浏览器 ──(Google Identity Services)──> Google，拿到 ID token（一个 JWT）
//   浏览器 ──POST /api/auth/google { credential }──> 这里
//   这里验签 + 核对 aud/iss/exp，写一个 HttpOnly 的会话 cookie 回去
//
// 之后的每个请求都只认我们自己的 cookie，不再碰 Google。ID token 只活几分钟，
// 拿它当长期凭证会让用户每小时被踢一次。

import crypto from 'node:crypto'

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com'])
/** 容忍的时钟偏差。服务器和 Google 的时钟不会完全同步。 */
const CLOCK_SKEW_SECONDS = 60
/** JWKS 没给缓存时长时的兜底。Google 实际大概几小时轮换一次。 */
const JWKS_FALLBACK_TTL_MS = 60 * 60 * 1000

export class AuthError extends Error {
  constructor(message, code = 'invalid_token') {
    super(message)
    this.name = 'AuthError'
    this.code = code
  }
}

// ── Google ID token ─────────────────────────────────────────────────────

let jwksCache = { keys: new Map(), expiresAt: 0, inflight: null }

/** 只给测试用：让每个用例从干净的缓存开始。 */
export function resetJwksCache() {
  jwksCache = { keys: new Map(), expiresAt: 0, inflight: null }
}

/**
 * 取 Google 的公钥集，按 Cache-Control 缓存。
 *
 * 并发的登录请求合流到同一次 fetch：十个人同时点登录不该打十次 Google。
 */
async function fetchJwks(fetchImpl = fetch) {
  if (Date.now() < jwksCache.expiresAt && jwksCache.keys.size > 0) return jwksCache.keys
  if (jwksCache.inflight) return jwksCache.inflight

  jwksCache.inflight = (async () => {
    const response = await fetchImpl(GOOGLE_JWKS_URL, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new AuthError(`could not fetch Google signing keys (HTTP ${response.status})`, 'jwks_unavailable')
    const body = await response.json()
    const keys = new Map()
    for (const jwk of body?.keys ?? []) {
      if (jwk?.kid && jwk.kty === 'RSA') keys.set(jwk.kid, jwk)
    }
    if (keys.size === 0) throw new AuthError('Google returned no usable signing keys', 'jwks_unavailable')

    const maxAge = /max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')
    const ttl = maxAge ? Number(maxAge[1]) * 1000 : JWKS_FALLBACK_TTL_MS
    jwksCache = { keys, expiresAt: Date.now() + ttl, inflight: null }
    return keys
  })()

  try {
    return await jwksCache.inflight
  } catch (err) {
    jwksCache.inflight = null
    throw err
  }
}

function base64urlToBuffer(value) {
  return Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function decodeSegment(segment) {
  const json = base64urlToBuffer(segment).toString('utf8')
  const parsed = JSON.parse(json)
  if (!parsed || typeof parsed !== 'object') throw new AuthError('malformed token segment')
  return parsed
}

/**
 * 校验 Google ID token，返回里面的用户资料。
 *
 * 顺序是刻意的：先验签名，再看声明。反过来的话，攻击者伪造的 token 里的
 * 声明会先被当成数据处理，哪怕只是拿去打日志也多了一处可被利用的地方。
 */
export async function verifyGoogleIdToken(token, { clientId, fetchImpl = fetch, now = Date.now } = {}) {
  if (!clientId) throw new AuthError('Google sign-in is not configured on this server', 'not_configured')
  if (typeof token !== 'string' || token.length === 0) throw new AuthError('missing credential')
  // 一个 ID token 不到 2KB。更长的东西不值得拿去解析。
  if (token.length > 8192) throw new AuthError('credential is implausibly long')

  const parts = token.split('.')
  if (parts.length !== 3) throw new AuthError('credential is not a JWT')
  const [rawHeader, rawPayload, rawSignature] = parts

  let header
  try {
    header = decodeSegment(rawHeader)
  } catch {
    throw new AuthError('credential header is not readable')
  }
  // alg 必须由我们规定，不能听 token 自己的：接受 alg=none 或 HS256
  // 是 JWT 最经典的那个洞——后者能让攻击者拿公钥当 HMAC 密钥来签。
  if (header.alg !== 'RS256') throw new AuthError(`unsupported signing algorithm ${String(header.alg)}`)
  if (typeof header.kid !== 'string') throw new AuthError('credential has no key id')

  let keys = await fetchJwks(fetchImpl)
  let jwk = keys.get(header.kid)
  if (!jwk) {
    // Google 轮换了签名密钥，我们缓存的那份已经过时。强制刷新一次再找。
    jwksCache.expiresAt = 0
    keys = await fetchJwks(fetchImpl)
    jwk = keys.get(header.kid)
  }
  if (!jwk) throw new AuthError('credential was signed by an unknown key')

  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' })
  const verified = crypto
    .createVerify('RSA-SHA256')
    .update(`${rawHeader}.${rawPayload}`)
    .verify(publicKey, base64urlToBuffer(rawSignature))
  if (!verified) throw new AuthError('credential signature does not check out')

  let payload
  try {
    payload = decodeSegment(rawPayload)
  } catch {
    throw new AuthError('credential payload is not readable')
  }

  if (!GOOGLE_ISSUERS.has(payload.iss)) throw new AuthError('credential was not issued by Google')
  // aud 把 token 绑在**我们这个**客户端上。不核对它的话，任何一个 Google
  // 应用拿到的 token 都能用来登录这里。
  if (payload.aud !== clientId) throw new AuthError('credential was issued for a different application')

  const seconds = Math.floor(now() / 1000)
  if (typeof payload.exp !== 'number' || seconds > payload.exp + CLOCK_SKEW_SECONDS) {
    throw new AuthError('credential has expired', 'expired_token')
  }
  if (typeof payload.iat === 'number' && seconds + CLOCK_SKEW_SECONDS < payload.iat) {
    throw new AuthError('credential is not valid yet')
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new AuthError('credential has no subject')
  // 未验证的邮箱可以是任何值。拿它当身份会让人注册一个声称是别人邮箱的账号。
  if (payload.email && payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new AuthError('this Google account has no verified email address', 'email_unverified')
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : '',
    name: typeof payload.name === 'string' ? payload.name : '',
    picture: typeof payload.picture === 'string' && /^https:\/\//.test(payload.picture) ? payload.picture : '',
  }
}

/** 用户 id：带上提供方前缀，将来接第二家登录时两边不会撞 id。 */
export function userIdForGoogle(sub) {
  return `google:${sub}`
}

// ── 会话 cookie ──────────────────────────────────────────────────────────

export const SESSION_COOKIE = 'rtfv_session'
/** 会话有效期。比文件保留期长得多——登录的意义正是隔几天回来还认得你。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 签一个会话值：`v1.<payload>.<hmac>`。
 *
 * 用签名而不是在服务端存一张会话表：这样登出、过期、重启都不需要额外状态，
 * 而我们本来也没有需要集中吊销会话的场景。代价是签出去的 token 在到期前
 * 无法单独作废——真要吊销，换掉 SESSION_SECRET 就是全体登出。
 */
export function signSession(userId, secret, { now = Date.now, ttlMs = SESSION_TTL_MS } = {}) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: now() + ttlMs }), 'utf8').toString('base64url')
  return `v1.${payload}.${hmac(payload, secret)}`
}

/** 校验会话值。任何一步不对都返回 null——调用方只关心"是谁"或"不是谁"。 */
export function readSession(value, secret, { now = Date.now } = {}) {
  if (typeof value !== 'string') return null
  const parts = value.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  const [, payload, signature] = parts

  const expected = hmac(payload, secret)
  // 定长比较：用 === 比较 HMAC 会把"前几个字节对不对"通过耗时泄露出去。
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  let parsed
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed.uid !== 'string' || typeof parsed.exp !== 'number') return null
  if (now() > parsed.exp) return null
  return { userId: parsed.uid, expiresAt: parsed.exp }
}

function hmac(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

// ── cookie 头 ────────────────────────────────────────────────────────────

/** 解析 Cookie 请求头。值里的百分号编码由我们自己写入时产生，这里解回来。 */
export function parseCookies(header) {
  const out = {}
  if (typeof header !== 'string') return out
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const key = pair.slice(0, eq).trim()
    if (!key) continue
    const raw = pair.slice(eq + 1).trim()
    try {
      out[key] = decodeURIComponent(raw)
    } catch {
      out[key] = raw
    }
  }
  return out
}

/**
 * 组装 Set-Cookie。
 *
 *   HttpOnly  —— JS 读不到它。一个 XSS 就不能把会话偷走。
 *   SameSite=Lax —— 跨站的 POST 不会带上它，CSRF 的大半面就没了。
 *                   Lax 而不是 Strict：从 Google 搜索结果点进来时仍然是登录态，
 *                   Strict 会让用户以为自己被登出了。
 *   Secure    —— 只走 HTTPS。本地 http://127.0.0.1 开发时必须关掉，
 *                否则浏览器会直接丢弃这个 cookie，表现是"登录成功但没登上"。
 */
export function serializeCookie(name, value, { maxAgeMs, secure = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (secure) parts.push('Secure')
  if (maxAgeMs !== undefined) {
    parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`)
    parts.push(`Expires=${new Date(Date.now() + maxAgeMs).toUTCString()}`)
  }
  return parts.join('; ')
}

/** 登出：发一个立刻过期的同名 cookie，浏览器据此把它删掉。 */
export function clearCookie(name, { secure = true } = {}) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
}
