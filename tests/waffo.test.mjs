import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CreditLedger } from '../scripts/credits.mjs'
import { applyTestWebhook, loadWaffoPrivateKey } from '../scripts/waffo.mjs'

test('Waffo private key supports environment value and file fallback', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waffo-key-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'key.pem')
  fs.writeFileSync(file, 'file-key')
  assert.equal(await loadWaffoPrivateKey({ privateKey: 'environment-key', privateKeyFile: file }), 'environment-key')
  assert.equal(await loadWaffoPrivateKey({ privateKeyFile: file }), 'file-key')
  await assert.rejects(loadWaffoPrivateKey({}), /configuration is incomplete/)
})

test('test payment is bound to a local order and deduplicated', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waffo-'))
  const ledger = new CreditLedger(path.join(dir, 'credits.sqlite'))
  t.after(() => { ledger.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  ledger.createCheckout('checkout1', 'user1', 'onetime')
  const config = { billing: { storeId: 'store1' } }
  const event = {
    mode: 'test', storeId: 'store1', eventType: 'order.completed',
    data: { orderMerchantExternalId: 'checkout1', merchantProvidedBuyerIdentity: 'user1',
      paymentId: 'payment1', paymentStatus: 'succeeded', currency: 'USD', chargedAmount: '2.90' },
  }
  assert.throws(() => applyTestWebhook(config, ledger, { ...event, mode: 'prod' }))
  assert.throws(() => applyTestWebhook(config, ledger, { ...event, data: { ...event.data, chargedAmount: '0' } }))
  assert.deepEqual(applyTestWebhook(config, ledger, event), { credited: true })
  assert.deepEqual(applyTestWebhook(config, ledger, event), { credited: false })
  assert.equal(ledger.balance('user1').total, 315)
  applyTestWebhook(config, ledger, { ...event, eventType: 'refund.succeeded' })
  assert.equal(ledger.reserve('user1', 'job', 1), 'billing_hold')
})

test('subscription periods are bound to checkout and cannot grant twice or rewind', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waffo-sub-'))
  const ledger = new CreditLedger(path.join(dir, 'credits.sqlite'))
  t.after(() => { ledger.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  ledger.createCheckout('checkout-sub', 'user1', 'pro')
  const config = { billing: { storeId: 'store1', subscriptionsEnabled: true } }
  const event = {
    mode: 'test', storeId: 'store1', eventType: 'subscription.activated',
    data: { orderMerchantExternalId: 'checkout-sub', merchantProvidedBuyerIdentity: 'user1',
      orderId: 'order1', orderStatus: 'active', currency: 'USD', billingPeriod: 'monthly',
      currentPeriodStart: '2026-01-01T00:00:00Z', currentPeriodEnd: '2026-02-01T00:00:00Z' },
  }
  const period1 = Date.parse(event.data.currentPeriodStart)
  assert.deepEqual(applyTestWebhook(config, ledger, event), { credited: true })
  assert.deepEqual(applyTestWebhook(config, ledger, event), { credited: false })
  assert.equal(ledger.balance('user1', period1 + 1).total, 3615)
  assert.equal(ledger.reserve('user1', 'job', 100, period1 + 1), 'reserved')
  const renewed = { ...event, eventType: 'subscription.renewed', data: { ...event.data,
    currentPeriodStart: '2026-02-01T00:00:00Z', currentPeriodEnd: '2026-03-01T00:00:00Z' } }
  assert.deepEqual(applyTestWebhook(config, ledger, renewed), { credited: true })
  assert.deepEqual(applyTestWebhook(config, ledger, event), { credited: false })
  assert.equal(ledger.balance('user1', Date.parse('2026-02-02T00:00:00Z')).total, 3615)
  assert.throws(() => applyTestWebhook(config, ledger, { ...renewed, data: { ...renewed.data, orderId: 'different' } }))
  assert.throws(() => applyTestWebhook(config, ledger, { ...renewed, data: { ...renewed.data, merchantProvidedBuyerIdentity: 'other' } }))
  assert.throws(() => applyTestWebhook({ billing: { storeId: 'store1' } }, ledger, renewed))
  assert.equal(ledger.balance('user1', Date.parse('2026-03-02T00:00:00Z')).plan, null)
})

test('an early simulated renewal keeps the active period until its boundary', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waffo-future-'))
  const ledger = new CreditLedger(path.join(dir, 'credits.sqlite'))
  t.after(() => { ledger.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  ledger.createCheckout('checkout-future', 'user1', 'starter')
  const now = Date.now()
  const boundary = now + 60_000
  const config = { billing: { storeId: 'store1', subscriptionsEnabled: true } }
  const event = {
    mode: 'test', storeId: 'store1', eventType: 'subscription.activated',
    data: { orderMerchantExternalId: 'checkout-future', orderId: 'order1',
      orderStatus: 'active', currency: 'USD', billingPeriod: 'monthly',
      currentPeriodStart: new Date(now - 60_000).toISOString(), currentPeriodEnd: new Date(boundary).toISOString() },
  }
  applyTestWebhook(config, ledger, event)
  ledger.reserve('user1', 'job', 100, now)
  const renewal = { ...event, eventType: 'subscription.renewed', data: { ...event.data,
    currentPeriodStart: new Date(boundary).toISOString(), currentPeriodEnd: new Date(boundary + 60_000).toISOString() } }
  assert.deepEqual(applyTestWebhook(config, ledger, renewal), { credited: true })
  assert.equal(ledger.balance('user1', now).total, 515)
  assert.deepEqual(applyTestWebhook(config, ledger, renewal), { credited: false })
  assert.equal(ledger.balance('user1', boundary).total, 615)
  assert.deepEqual(applyTestWebhook(config, ledger, renewal), { credited: false })
  assert.equal(ledger.balance('user1', boundary).total, 615)
})
