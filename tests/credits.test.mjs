import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CreditLedger, creditCost } from '../scripts/credits.mjs'

test('credit costs round video duration up and charge three times for box mode', () => {
  assert.equal(creditCost(100.1, 'auto'), 101)
  assert.equal(creditCost(100.1, 'box'), 303)
  assert.throws(() => creditCost(0, 'box'))
  assert.throws(() => creditCost(1, 'unknown'))
})

test('welcome grant, reservations and refunds are durable and idempotent', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'credits.sqlite')
  let ledger = new CreditLedger(file)
  assert.equal(ledger.ensureAccount('u').total, 15)
  assert.equal(ledger.ensureAccount('u').total, 15)
  assert.equal(ledger.reserve('u', 'job1', 10), 'reserved')
  assert.equal(ledger.reserve('u', 'job1', 10), 'reserved')
  assert.throws(() => ledger.reserve('u', 'job1', 9))
  assert.equal(ledger.reserve('u', 'job2', 6), 'insufficient')
  ledger.close()
  ledger = new CreditLedger(file)
  assert.equal(ledger.balance('u').total, 5)
  assert.equal(ledger.settle('job1', false), 'refunded')
  assert.equal(ledger.settle('job1', false), 'refunded')
  assert.equal(ledger.balance('u').total, 15)
  assert.equal(ledger.grantPermanent('u', 'payment1', 300), true)
  assert.equal(ledger.grantPermanent('u', 'payment1', 300), false)
  assert.throws(() => ledger.grantPermanent('u', 'payment1', 600))
  assert.equal(ledger.balance('u').total, 315)
  ledger.close()
})

test('subscription credits reset per period and old refunds do not refill a new period', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const ledger = new CreditLedger(path.join(dir, 'credits.sqlite'))
  t.after(() => ledger.close())
  const first = { plan: 'starter', periodId: 'p1', periodStart: 1000, periodEnd: 2000 }
  assert.equal(ledger.grantSubscription('u', 'g1', first), true)
  assert.equal(ledger.grantSubscription('u', 'g1', first), false)
  assert.throws(() => ledger.grantSubscription('u', 'g1', { ...first, periodEnd: 3000 }))
  assert.equal(ledger.reserve('u', 'job', 605, 1500), 'reserved')
  assert.deepEqual(ledger.balance('u', 1500).total, 10)
  assert.equal(ledger.grantSubscription('u', 'g2', { ...first, periodId: 'p2', periodStart: 2000, periodEnd: 3000 }), true)
  assert.equal(ledger.settle('job', false, 2500), 'refunded')
  assert.equal(ledger.balance('u', 2500).total, 615)
  assert.throws(() => ledger.grantSubscription('u', 'g3', first))
  assert.equal(ledger.balance('u', 3000).total, 15)
})

test('future renewals preserve current credits until the new period starts, including after restart', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-future-'))
  const file = path.join(dir, 'credits.sqlite')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const now = Date.now()
  const boundary = now + 60_000
  let ledger = new CreditLedger(file)
  ledger.grantSubscription('u', 'g1', { plan: 'starter', periodId: 'p1', periodStart: now - 60_000, periodEnd: boundary })
  assert.equal(ledger.reserve('u', 'job1', 100, now), 'reserved')
  const next = { plan: 'starter', periodId: 'p2', periodStart: boundary, periodEnd: boundary + 60_000 }
  assert.equal(ledger.grantSubscription('u', 'g2', next), true)
  assert.equal(ledger.grantSubscription('u', 'g2', next), false)
  assert.equal(ledger.balance('u', now).total, 515)
  assert.equal(ledger.reserve('u', 'job2', 50, now), 'reserved')
  assert.equal(ledger.settle('job1', false, now), 'refunded')
  assert.equal(ledger.balance('u', now).total, 565)
  ledger.close()

  ledger = new CreditLedger(file)
  t.after(() => ledger.close())
  assert.equal(ledger.balance('u', boundary - 1).total, 565)
  assert.equal(ledger.balance('u', boundary).total, 615)
  assert.equal(ledger.reserve('u', 'job3', 40, boundary), 'reserved')
  assert.equal(ledger.settle('job2', false, boundary), 'refunded')
  assert.equal(ledger.balance('u', boundary).total, 575)
  assert.equal(ledger.settle('job3', false, boundary), 'refunded')
  assert.equal(ledger.balance('u', boundary).total, 615)
  assert.equal(ledger.balance('u', boundary + 60_000).total, 15)
})
