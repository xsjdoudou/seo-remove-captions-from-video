import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkRateLimit } from '../scripts/erase-api.mjs'

test('daily exemptions apply only to the specified signed-in user', () => {
  const config = { rateLimitConcurrent: 2, rateLimitDaily: 1, rateLimitDailyExemptUsers: ['email:exempt'] }
  const store = { list: () => [
    { userId: 'email:exempt', ip: '127.0.0.1', createdAt: Date.now() },
    { userId: 'email:other', ip: '127.0.0.1', createdAt: Date.now() },
  ] }
  const pipeline = { activeCountForOwner: () => 0 }
  const check = (userId, activePipeline = pipeline) =>
    checkRateLimit({ config, store, pipeline: activePipeline, userId, ip: '127.0.0.1' })

  assert.equal(check('email:exempt'), null)
  assert.equal(check('email:other').code, 'daily_limit')
  assert.equal(check(null).code, 'daily_limit')
  assert.equal(check('email:exempt', { activeCountForOwner: () => 2 }).code, 'too_many_active')
})
