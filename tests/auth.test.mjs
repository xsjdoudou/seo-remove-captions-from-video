// 登录相关的单元测试。
//
//   npm test
//
// 这一块是整个仓库里出错后果最重的地方：一个没核对的 aud、一个用 === 做的
// HMAC 比较、一个被接受的 alg=none，都不会让任何功能看起来坏掉，但等于把
// 所有人的账号敞开。所以这里是按"攻击者会怎么试"来写的，而不是按
// "正常流程跑得通吗"。
//
// 不打 Google 的网络：自己生成一对 RSA 密钥，假装成 Google 的 JWKS 端点。
// 这样测试离线可跑，也能构造出真实流量里见不到的畸形 token。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import {
  AuthError,
  clearCookie,
  parseCookies,
  readSession,
  resetJwksCache,
  serializeCookie,
  signSession,
  userIdForGoogle,
  verifyGoogleIdToken,
} from '../scripts/auth.mjs'
import { JobStore, UserStore } from '../scripts/store.mjs'
import { serializeJob } from '../scripts/erase-api.mjs'

// ── 测试替身 ────────────────────────────────────────────────────────────

const CLIENT_ID = '1234567890-test.apps.googleusercontent.com'
const KID = 'test-key-1'
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })

function base64url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64url')
}

/** 签一个 ID token。传 header/payload 的覆盖项来构造各种畸形输入。 */
function makeToken({ header = {}, payload = {}, signWith = privateKey, tamper = false } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const fullHeader = { alg: 'RS256', kid: KID, typ: 'JWT', ...header }
  const fullPayload = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '110000000000000000001',
    email: 'someone@example.com',
    email_verified: true,
    name: 'Someone',
    picture: 'https://lh3.googleusercontent.com/a/photo',
    iat: now,
    exp: now + 3600,
    ...payload,
  }
  const signingInput = `${base64url(fullHeader)}.${base64url(fullPayload)}`
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(signWith).toString('base64url')
  if (tamper) {
    // 改掉 payload 但留着原来的签名——这正是"改一下 aud 看看过不过"的做法。
    const evil = base64url({ ...fullPayload, sub: 'attacker' })
    return `${base64url(fullHeader)}.${evil}.${signature}`
  }
  return `${signingInput}.${signature}`
}

/** 假的 JWKS 端点。记下被调了几次，用来验证缓存确实生效。 */
function makeJwksFetch() {
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }
  const impl = async () => {
    impl.calls += 1
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'cache-control' ? 'public, max-age=3600' : null) },
      json: async () => ({ keys: [jwk] }),
    }
  }
  impl.calls = 0
  return impl
}

// ── Google ID token ─────────────────────────────────────────────────────

test('verifyGoogleIdToken accepts a well-formed token and returns the profile', async () => {
  resetJwksCache()
  const profile = await verifyGoogleIdToken(makeToken(), { clientId: CLIENT_ID, fetchImpl: makeJwksFetch() })
  assert.equal(profile.sub, '110000000000000000001')
  assert.equal(profile.email, 'someone@example.com')
  assert.equal(profile.name, 'Someone')
})

test('verifyGoogleIdToken rejects a token meant for another application', async () => {
  // aud 是把 token 绑在我们这个客户端上的唯一一道。不核对它的话，任何一个
  // Google 应用——包括攻击者自己注册的那个——拿到的 token 都能登进来。
  resetJwksCache()
  await assert.rejects(
    verifyGoogleIdToken(makeToken({ payload: { aud: 'someone-elses-client-id' } }), {
      clientId: CLIENT_ID,
      fetchImpl: makeJwksFetch(),
    }),
    /different application/,
  )
})

test('verifyGoogleIdToken rejects a token that was not issued by Google', async () => {
  resetJwksCache()
  await assert.rejects(
    verifyGoogleIdToken(makeToken({ payload: { iss: 'https://evil.example.com' } }), {
      clientId: CLIENT_ID,
      fetchImpl: makeJwksFetch(),
    }),
    /not issued by Google/,
  )
})

test('verifyGoogleIdToken rejects alg=none and symmetric algorithms', async () => {
  // JWT 最经典的那两个洞：alg=none 让签名变成可选，HS256 让攻击者拿公钥
  // 当 HMAC 密钥自己签一个。alg 必须由我们规定，不能听 token 自己的。
  resetJwksCache()
  for (const alg of ['none', 'HS256', 'RS512']) {
    await assert.rejects(
      verifyGoogleIdToken(makeToken({ header: { alg } }), { clientId: CLIENT_ID, fetchImpl: makeJwksFetch() }),
      /unsupported signing algorithm/,
      `alg=${alg} should be refused`,
    )
  }
})

test('verifyGoogleIdToken rejects a payload that was edited after signing', async () => {
  resetJwksCache()
  await assert.rejects(
    verifyGoogleIdToken(makeToken({ tamper: true }), { clientId: CLIENT_ID, fetchImpl: makeJwksFetch() }),
    /signature does not check out/,
  )
})

test('verifyGoogleIdToken rejects a token signed by the wrong key', async () => {
  resetJwksCache()
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  await assert.rejects(
    verifyGoogleIdToken(makeToken({ signWith: other.privateKey }), {
      clientId: CLIENT_ID,
      fetchImpl: makeJwksFetch(),
    }),
    /signature does not check out/,
  )
})

test('verifyGoogleIdToken rejects an expired token', async () => {
  resetJwksCache()
  const now = Math.floor(Date.now() / 1000)
  await assert.rejects(
    verifyGoogleIdToken(makeToken({ payload: { exp: now - 3600, iat: now - 7200 } }), {
      clientId: CLIENT_ID,
      fetchImpl: makeJwksFetch(),
    }),
    /expired/,
  )
})

test('verifyGoogleIdToken rejects an unverified email address', async () => {
  // 未验证的邮箱可以是任何值。拿它当身份会让人注册一个声称是别人邮箱的账号。
  resetJwksCache()
  await assert.rejects(
    verifyGoogleIdToken(makeToken({ payload: { email_verified: false } }), {
      clientId: CLIENT_ID,
      fetchImpl: makeJwksFetch(),
    }),
    /no verified email/,
  )
})

test('verifyGoogleIdToken refuses to work without a configured client id', async () => {
  resetJwksCache()
  await assert.rejects(verifyGoogleIdToken(makeToken(), { clientId: '' }), /not configured/)
})

test('verifyGoogleIdToken rejects obvious garbage without fetching anything', async () => {
  resetJwksCache()
  const impl = makeJwksFetch()
  for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', null, 42]) {
    await assert.rejects(verifyGoogleIdToken(bad, { clientId: CLIENT_ID, fetchImpl: impl }), AuthError)
  }
  assert.equal(impl.calls, 0, 'malformed input should be rejected before hitting the network')
})

test('verifyGoogleIdToken caches the signing keys instead of refetching per sign-in', async () => {
  resetJwksCache()
  const impl = makeJwksFetch()
  await verifyGoogleIdToken(makeToken(), { clientId: CLIENT_ID, fetchImpl: impl })
  await verifyGoogleIdToken(makeToken(), { clientId: CLIENT_ID, fetchImpl: impl })
  await verifyGoogleIdToken(makeToken(), { clientId: CLIENT_ID, fetchImpl: impl })
  assert.equal(impl.calls, 1)
})

test('verifyGoogleIdToken drops a picture URL that is not https', async () => {
  // 这个值会被原样塞进 <img src>。http 的地址会让整页变成混合内容。
  resetJwksCache()
  const profile = await verifyGoogleIdToken(makeToken({ payload: { picture: 'javascript:alert(1)' } }), {
    clientId: CLIENT_ID,
    fetchImpl: makeJwksFetch(),
  })
  assert.equal(profile.picture, '')
})

// ── 会话 cookie ─────────────────────────────────────────────────────────

const SECRET = 'a'.repeat(64)

test('signSession and readSession round-trip a user id', () => {
  const session = readSession(signSession('google:42', SECRET), SECRET)
  assert.equal(session.userId, 'google:42')
  assert.ok(session.expiresAt > Date.now())
})

test('readSession rejects a value signed with a different secret', () => {
  // 换掉 SESSION_SECRET 就该是全体登出。
  assert.equal(readSession(signSession('google:42', SECRET), 'b'.repeat(64)), null)
})

test('readSession rejects an edited payload', () => {
  // 把自己的会话改成别人的 uid 再发回来——签名必须拦住它。
  const value = signSession('google:42', SECRET)
  const [version, payload, signature] = value.split('.')
  const evil = Buffer.from(JSON.stringify({ uid: 'google:1', exp: Date.now() + 1000 }), 'utf8').toString('base64url')
  assert.equal(readSession(`${version}.${evil}.${signature}`, SECRET), null)
})

test('readSession rejects an expired session', () => {
  assert.equal(readSession(signSession('google:42', SECRET, { ttlMs: -1000 }), SECRET), null)
})

test('readSession rejects malformed values rather than throwing', () => {
  // 这些全都来自请求头，也就是说全都由调用方控制。抛异常等于把 500 的
  // 开关交给任何人。
  for (const bad of [undefined, null, 42, '', 'x', 'v1.x', 'v2.a.b', 'v1..', 'v1.notbase64!.sig']) {
    assert.equal(readSession(bad, SECRET), null, `${String(bad)} should be refused quietly`)
  }
})

test('parseCookies reads the forms a browser actually sends', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' })
  assert.deepEqual(parseCookies('rtfv_session=v1.abc.def'), { rtfv_session: 'v1.abc.def' })
  // 值里可能有百分号编码，也可能有 = （base64 的填充）。
  assert.deepEqual(parseCookies('x=a%20b; y=p==='), { x: 'a b', y: 'p===' })
  assert.deepEqual(parseCookies(undefined), {})
  assert.deepEqual(parseCookies('garbage'), {})
})

test('the session cookie is HttpOnly, SameSite=Lax and Secure in production', () => {
  const cookie = serializeCookie('rtfv_session', 'value', { maxAgeMs: 1000, secure: true })
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  assert.match(cookie, /Secure/)
  assert.match(cookie, /Max-Age=1/)
  // 本地 http 开发必须能关掉 Secure，否则浏览器直接丢弃这个 cookie。
  assert.doesNotMatch(serializeCookie('n', 'v', { secure: false }), /Secure/)
})

test('clearCookie expires the cookie immediately', () => {
  const cookie = clearCookie('rtfv_session', { secure: true })
  assert.match(cookie, /Max-Age=0/)
  assert.match(cookie, /HttpOnly/)
})

test('userIdForGoogle namespaces the provider', () => {
  // 将来接第二家登录时，两边的 id 不能撞上。
  assert.equal(userIdForGoogle('12345'), 'google:12345')
})

// ── 按用户存历史 ────────────────────────────────────────────────────────

test('listByUser returns only that user, newest first', () => {
  const store = new JobStore('/tmp/does-not-matter.json')
  const mine1 = store.create({ status: 'completed', userId: 'google:1', createdAt: 1000 })
  const mine2 = store.create({ status: 'completed', userId: 'google:1', createdAt: 3000 })
  store.create({ status: 'completed', userId: 'google:2', createdAt: 2000 })
  store.create({ status: 'completed', userId: null, createdAt: 4000 })

  const { jobs, total } = store.listByUser('google:1')
  assert.deepEqual(jobs.map((job) => job.id), [mine2.id, mine1.id])
  assert.equal(total, 2)
})

test('listByUser never returns anonymous jobs', () => {
  // 匿名任务没有主人。把它们算进任何人的历史里，等于把别人的文件名
  // 列给了一个碰巧登录了的访客。
  const store = new JobStore('/tmp/does-not-matter.json')
  store.create({ status: 'completed', userId: null, createdAt: 1000 })
  assert.deepEqual(store.listByUser('google:1').jobs, [])
  assert.deepEqual(store.listByUser(null).jobs, [])
  assert.deepEqual(store.listByUser('').jobs, [])
})

test('listByUser paginates', () => {
  const store = new JobStore('/tmp/does-not-matter.json')
  for (let i = 0; i < 5; i += 1) store.create({ status: 'completed', userId: 'u', createdAt: i * 1000 })
  const { jobs, total } = store.listByUser('u', { limit: 2, offset: 1 })
  assert.equal(jobs.length, 2)
  assert.equal(total, 5)
  assert.deepEqual(jobs.map((job) => job.createdAt), [3000, 2000])
})

test('serializeJob reports a purged job as expired, with no download link', () => {
  // 登录用户的记录活得比文件久。文件被清掉之后还给出下载链接的话，
  // 用户点下去只会拿到一个 404，而列表上写着 "Ready"。
  const job = {
    id: 'a'.repeat(24),
    token: 'b'.repeat(24),
    status: 'completed',
    filename: 'clip.mp4',
    createdAt: 0,
    updatedAt: 0,
    userId: 'google:1',
    filesPurgedAt: 1_700_000_000_000,
  }
  const result = serializeJob(job, { publicBase: 'https://example.com', retentionMs: 1000 })
  assert.equal(result.status, 'expired')
  assert.equal(result.resultUrl, null)
  assert.equal(result.downloadUrl, null)
})

test('serializeJob never leaks the owning account id', () => {
  // userId 不在白名单里。它泄出去本身不致命，但列表接口会把同一个用户的
  // 几十条记录一起发出去，任何一处疏漏都会被放大。
  const job = {
    id: 'a'.repeat(24),
    token: 'b'.repeat(24),
    status: 'completed',
    filename: 'clip.mp4',
    createdAt: 0,
    updatedAt: 0,
    userId: 'google:110000000000000000001',
    ip: '203.0.113.9',
  }
  const serialized = JSON.stringify(serializeJob(job, { publicBase: '', retentionMs: 1000 }))
  assert.ok(!serialized.includes('110000000000000000001'), 'account id leaked')
  assert.ok(!serialized.includes('203.0.113.9'), 'client IP leaked')
})

// ── 用户表 ──────────────────────────────────────────────────────────────

test('UserStore upsert creates then refreshes the profile', () => {
  const users = new UserStore('/tmp/does-not-matter.json')
  const created = users.upsert('google:1', { email: 'a@example.com', name: 'A', picture: '' })
  assert.equal(created.email, 'a@example.com')
  assert.ok(created.createdAt > 0)

  // 用户在 Google 那边改了名字，下次登录应该跟着变，而不是建第二个账号。
  const updated = users.upsert('google:1', { email: 'a@example.com', name: 'A Renamed', picture: '' })
  assert.equal(updated.name, 'A Renamed')
  assert.equal(updated.createdAt, created.createdAt)
  assert.equal(users.list().length, 1)
})

test('UserStore touch returns null for an account that no longer exists', () => {
  // 会话签名有效 ≠ 这个人还在。删过账号之后旧 cookie 必须变成"未登录"，
  // 而不是一个指向空记录的登录态。
  const users = new UserStore('/tmp/does-not-matter.json')
  assert.equal(users.touch('google:gone'), null)
})
