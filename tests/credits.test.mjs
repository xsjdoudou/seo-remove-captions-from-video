import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CreditLedger } from '../scripts/credits.mjs'

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
  assert.equal(ledger.balance('u', 2500).total, 1215)
  assert.throws(() => ledger.grantSubscription('u', 'g3', first))
  assert.equal(ledger.balance('u', 3000).total, 615)
})
