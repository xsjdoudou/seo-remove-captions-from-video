import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CreditLedger } from '../scripts/credits.mjs'
import { applyTestWebhook } from '../scripts/waffo.mjs'

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
