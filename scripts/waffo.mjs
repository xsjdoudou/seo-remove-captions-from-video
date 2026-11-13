import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import { WaffoPancake, verifyWebhook } from '@waffo/pancake-ts'
import { BILLING_PLANS } from './credits.mjs'

export async function createTestCheckout(config, ledger, user, planId) {
  // Subscription checkout remains disabled until lifecycle reconciliation is implemented.
  if (planId !== 'onetime') throw new Error('This plan is not available yet')
  const settings = config.billing
  if (!settings.merchantId || !settings.storeId || !settings.privateKeyFile ||
      !/^https:\/\//.test(config.publicBase)) throw new Error('Waffo test configuration is incomplete')
  const privateKey = await fsp.readFile(settings.privateKeyFile, 'utf8')
  const client = new WaffoPancake({ merchantId: settings.merchantId, privateKey, environment: 'test' })
  const id = `erase_${crypto.randomBytes(16).toString('hex')}`
  ledger.createCheckout(id, user.id, planId)
  const result = await client.checkout.authenticated.create({
    productId: BILLING_PLANS[planId].productId,
    currency: 'USD',
    buyerIdentity: user.id,
    buyerEmail: user.email,
    successUrl: `${config.publicBase}/?payment=success`,
    orderMerchantExternalId: id,
  })
  if (typeof result.checkoutUrl !== 'string' || !/^https:\/\//.test(result.checkoutUrl)) {
    throw new Error('Invalid checkout URL')
  }
  return result.checkoutUrl
}

export async function verifyTestWebhook(config, rawBody, signature) {
  const options = { environment: 'test' }
  if (config.billing.webhookPublicKeyFile) {
    options.publicKey = await fsp.readFile(config.billing.webhookPublicKeyFile, 'utf8')
  }
  return verifyWebhook(rawBody, signature, options)
}

export function applyTestWebhook(config, ledger, event) {
  if (event.mode !== 'test' || !config.billing.storeId || event.storeId !== config.billing.storeId) {
    throw new Error('Webhook store or environment mismatch')
  }
  const data = event.data ?? {}
  if (!['order.completed', 'refund.succeeded'].includes(event.eventType)) return { ignored: true }
  const order = ledger.getCheckout(data.orderMerchantExternalId)
  if (!order || (data.merchantProvidedBuyerIdentity && data.merchantProvidedBuyerIdentity !== order.user_id)) {
    throw new Error('Unknown checkout or buyer')
  }
  if (event.eventType === 'refund.succeeded') {
    ledger.holdAccount(order.user_id, `Waffo refund for ${order.id}`)
    return { held: true }
  }
  if (order.plan !== 'onetime' || data.currency !== 'USD' || data.paymentStatus !== 'succeeded' ||
      typeof data.paymentId !== 'string' || !/^\d+(\.\d{1,2})?$/.test(String(data.chargedAmount ?? '')) ||
      Math.round(Number(data.chargedAmount) * 100) < Math.round(Number(BILLING_PLANS.onetime.price) * 100)) {
    throw new Error('Invalid payment')
  }
  return { credited: ledger.recordOneTimePayment(order.id, data.paymentId) }
}
