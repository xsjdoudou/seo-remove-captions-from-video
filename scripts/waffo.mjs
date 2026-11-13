import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import { WaffoPancake, verifyWebhook } from '@waffo/pancake-ts'
import { BILLING_PLANS } from './credits.mjs'

export async function loadWaffoPrivateKey(settings) {
  if (settings.privateKey) return settings.privateKey
  if (settings.privateKeyFile) return fsp.readFile(settings.privateKeyFile, 'utf8')
  throw new Error('Waffo configuration is incomplete')
}

export async function createTestCheckout(config, ledger, user, planId) {
  if (!Object.hasOwn(BILLING_PLANS, planId) ||
      (planId !== 'onetime' && !config.billing.subscriptionsEnabled)) throw new Error('This plan is not available yet')
  if (planId !== 'onetime' && ledger.getActiveSubscription(user.id)) throw new Error('An active subscription already exists')
  const settings = config.billing
  if (!settings.merchantId || !settings.storeId ||
      !/^https:\/\//.test(config.publicBase)) throw new Error('Waffo configuration is incomplete')
  const privateKey = await loadWaffoPrivateKey(settings)
  const client = new WaffoPancake({ merchantId: settings.merchantId, privateKey, environment: settings.environment ?? 'test' })
  const id = `erase_${crypto.randomBytes(16).toString('hex')}`
  ledger.createCheckout(id, user.id, planId)
  const result = await client.checkout.authenticated.create({
    productId: BILLING_PLANS[planId].productId,
    currency: 'USD',
    buyerIdentity: user.id,
    buyerEmail: user.email,
    successUrl: `${config.publicBase}/?payment=success`,
    orderMerchantExternalId: id,
    ...(planId === 'onetime' ? {} : { withTrial: false }),
  })
  if (typeof result.checkoutUrl !== 'string' || !/^https:\/\//.test(result.checkoutUrl)) {
    throw new Error('Invalid checkout URL')
  }
  return result.checkoutUrl
}

export async function createTestPortal(config, user) {
  const settings = config.billing
  if (!settings.merchantId || !settings.storeId || !settings.subscriptionsEnabled) {
    throw new Error('Waffo configuration is incomplete')
  }
  const privateKey = await loadWaffoPrivateKey(settings)
  const client = new WaffoPancake({ merchantId: settings.merchantId, privateKey, environment: settings.environment ?? 'test' })
  const { portalUrl } = await client.auth.createCustomerPortalLink({ storeId: settings.storeId, buyerIdentity: user.id })
  const url = new URL(portalUrl)
  if (url.protocol !== 'https:' || url.hostname !== 'pancake.waffo.ai') throw new Error('Invalid portal URL')
  return portalUrl
}

export async function verifyTestWebhook(config, rawBody, signature) {
  const options = { environment: config.billing.environment ?? 'test' }
  if (config.billing.webhookPublicKeyFile) {
    options.publicKey = await fsp.readFile(config.billing.webhookPublicKeyFile, 'utf8')
  }
  return verifyWebhook(rawBody, signature, options)
}

export function applyTestWebhook(config, ledger, event) {
  if (event.mode !== (config.billing.environment ?? 'test') || !config.billing.storeId || event.storeId !== config.billing.storeId) {
    throw new Error('Webhook store or environment mismatch')
  }
  const data = event.data ?? {}
  if (!['order.completed', 'refund.succeeded', 'subscription.activated', 'subscription.renewed', 'subscription.recovered'].includes(event.eventType)) return { ignored: true }
  const order = ledger.getCheckout(data.orderMerchantExternalId)
  if (!order || (data.merchantProvidedBuyerIdentity && data.merchantProvidedBuyerIdentity !== order.user_id)) {
    throw new Error('Unknown checkout or buyer')
  }
  if (event.eventType === 'refund.succeeded') {
    ledger.holdAccount(order.user_id, `Waffo refund for ${order.id}`)
    return { held: true }
  }
  if (event.eventType.startsWith('subscription.')) {
    if (!config.billing.subscriptionsEnabled || order.plan === 'onetime' ||
        data.currency !== 'USD' || data.billingPeriod !== 'monthly' || data.orderStatus !== 'active' ||
        typeof data.orderId !== 'string' || typeof data.currentPeriodStart !== 'string' || typeof data.currentPeriodEnd !== 'string') {
      throw new Error('Invalid subscription event')
    }
    const start = Date.parse(data.currentPeriodStart)
    const end = Date.parse(data.currentPeriodEnd)
    return { credited: ledger.applySubscriptionPeriod(order.id, data.orderId, start, end, 'active') }
  }
  if (order.plan !== 'onetime' || data.currency !== 'USD' || data.paymentStatus !== 'succeeded' ||
      typeof data.paymentId !== 'string' || !/^\d+(\.\d{1,2})?$/.test(String(data.chargedAmount ?? '')) ||
      Math.round(Number(data.chargedAmount) * 100) < Math.round(Number(BILLING_PLANS.onetime.price) * 100)) {
    throw new Error('Invalid payment')
  }
  return { credited: ledger.recordOneTimePayment(order.id, data.paymentId) }
}
