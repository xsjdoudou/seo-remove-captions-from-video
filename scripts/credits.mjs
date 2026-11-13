import Database from 'better-sqlite3'

export const BILLING_PLANS = Object.freeze({
  onetime: Object.freeze({ productId: 'PROD_6nPSW7ZgCw8FhG4DBlUYLl', credits: 300, price: '2.90' }),
  starter: Object.freeze({ productId: 'PROD_7jzWHOjqBplWpjDcfyqnKl', credits: 600, price: '4.90' }),
  pro: Object.freeze({ productId: 'PROD_5XZLbtjUf3drOQ6zswQaa2', credits: 3600, price: '14.90' }),
  business: Object.freeze({ productId: 'PROD_0cZxODveJbiE505HfjeIob', credits: 12000, price: '39.90' }),
})

export function creditCost(durationSeconds, mode) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !['auto', 'box'].includes(mode)) {
    throw new Error('Invalid credit cost input')
  }
  return Math.ceil(durationSeconds) * (mode === 'box' ? 3 : 1)
}

function identifier(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid identifier')
  return value
}

function amount(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid credit amount')
  return value
}

export class CreditLedger {
  constructor(file) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        user_id TEXT PRIMARY KEY,
        permanent INTEGER NOT NULL DEFAULT 15 CHECK(permanent >= 0),
        subscription INTEGER NOT NULL DEFAULT 0 CHECK(subscription >= 0),
        period_id TEXT,
        period_start INTEGER,
        period_end INTEGER,
        plan TEXT
      );
      CREATE TABLE IF NOT EXISTS grants (
        grant_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES accounts(user_id),
        kind TEXT NOT NULL,
        credits INTEGER NOT NULL,
        period_id TEXT,
        plan TEXT,
        period_start INTEGER,
        period_end INTEGER
      );
      CREATE TABLE IF NOT EXISTS reservations (
        job_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES accounts(user_id),
        permanent INTEGER NOT NULL,
        subscription INTEGER NOT NULL,
        period_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('reserved', 'refunded', 'consumed'))
      );
      CREATE TABLE IF NOT EXISTS checkout_orders (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhook_events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payment_ids (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS billing_holds (
        user_id TEXT PRIMARY KEY, reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS test_subscriptions (
        checkout_id TEXT PRIMARY KEY REFERENCES checkout_orders(id),
        provider_order_id TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        plan TEXT NOT NULL,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        status TEXT NOT NULL
      );
    `)
  }

  ensureAccount(userId) {
    identifier(userId)
    this.db.prepare('INSERT OR IGNORE INTO accounts (user_id) VALUES (?)').run(userId)
    return this.balance(userId)
  }

  balance(userId, now = Date.now()) {
    identifier(userId)
    return this.db.transaction(() => {
      let row = this.db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(userId)
      if (!row) return null
      const due = this.db.prepare(`SELECT * FROM grants WHERE user_id = ? AND kind = 'subscription'
        AND period_start <= ? ORDER BY period_start DESC LIMIT 1`).get(userId, now)
      if (due && (row.period_start == null || due.period_start > row.period_start)) {
        this.db.prepare(`UPDATE accounts SET subscription = ?, period_id = ?, period_start = ?,
          period_end = ?, plan = ? WHERE user_id = ?`)
          .run(due.credits, due.period_id, due.period_start, due.period_end, due.plan, userId)
        row = this.db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(userId)
      }
      const active = row.period_end != null && row.period_start <= now && now < row.period_end
      const subscription = active ? row.subscription : 0
      return { permanent: row.permanent, subscription, total: row.permanent + subscription,
        plan: active ? row.plan : null, periodId: row.period_id, periodEnd: row.period_end }
    })()
  }

  grantPermanent(userId, grantId, credits) {
    identifier(userId); identifier(grantId); amount(credits)
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM grants WHERE grant_id = ?').get(grantId)
      if (previous) {
        if (previous.user_id !== userId || previous.kind !== 'permanent' || previous.credits !== credits) {
          throw new Error('Grant id conflict')
        }
        return false
      }
      this.ensureAccount(userId)
      this.db.prepare("INSERT INTO grants (grant_id, user_id, kind, credits) VALUES (?, ?, 'permanent', ?)").run(grantId, userId, credits)
      this.db.prepare('UPDATE accounts SET permanent = permanent + ? WHERE user_id = ?').run(credits, userId)
      return true
    })()
  }

  grantSubscription(userId, grantId, { plan, periodId, periodStart, periodEnd }) {
    identifier(userId); identifier(grantId); identifier(periodId)
    const product = BILLING_PLANS[plan]
    if (!product || plan === 'onetime' || !Number.isSafeInteger(periodStart) ||
        !Number.isSafeInteger(periodEnd) || periodStart >= periodEnd) throw new Error('Invalid subscription period')
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM grants WHERE grant_id = ?').get(grantId)
      if (previous) {
        if (previous.user_id !== userId || previous.kind !== 'subscription' ||
            previous.credits !== product.credits || previous.period_id !== periodId || previous.plan !== plan ||
            previous.period_start !== periodStart || previous.period_end !== periodEnd) throw new Error('Grant id conflict')
        return false
      }
      this.ensureAccount(userId)
      const latest = this.db.prepare(`SELECT period_start, period_end FROM grants
        WHERE user_id = ? AND kind = 'subscription' ORDER BY period_start DESC LIMIT 1`).get(userId)
      if (latest && (periodStart <= latest.period_start || periodStart < latest.period_end)) {
        throw new Error('Subscription period is not newer')
      }
      this.db.prepare(`INSERT INTO grants (grant_id, user_id, kind, credits, period_id, plan, period_start, period_end)
        VALUES (?, ?, 'subscription', ?, ?, ?, ?, ?)`).run(grantId, userId, product.credits, periodId, plan, periodStart, periodEnd)
      return true
    })()
  }

  reserve(userId, jobId, credits, now = Date.now()) {
    identifier(userId); identifier(jobId); amount(credits)
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM billing_holds WHERE user_id = ?').get(userId)) return 'billing_hold'
      const previous = this.db.prepare('SELECT * FROM reservations WHERE job_id = ?').get(jobId)
      if (previous) {
        if (previous.user_id !== userId || previous.permanent + previous.subscription !== credits) {
          throw new Error('Reservation id conflict')
        }
        return previous.state
      }
      const balance = this.balance(userId, now)
      if (!balance || balance.total < credits) return 'insufficient'
      const subscription = Math.min(balance.subscription, credits)
      const permanent = credits - subscription
      this.db.prepare('UPDATE accounts SET subscription = subscription - ?, permanent = permanent - ? WHERE user_id = ?')
        .run(subscription, permanent, userId)
      this.db.prepare("INSERT INTO reservations VALUES (?, ?, ?, ?, ?, 'reserved')")
        .run(jobId, userId, permanent, subscription, subscription ? balance.periodId : null)
      return 'reserved'
    })()
  }

  settle(jobId, success, now = Date.now()) {
    identifier(jobId)
    return this.db.transaction(() => {
      const reservation = this.db.prepare('SELECT * FROM reservations WHERE job_id = ?').get(jobId)
      if (!reservation) throw new Error('Unknown reservation')
      if (reservation.state !== 'reserved') return reservation.state
      if (!success) {
        const balance = this.balance(reservation.user_id, now)
        const refundable = balance.plan && balance.periodId === reservation.period_id ? reservation.subscription : 0
        this.db.prepare('UPDATE accounts SET permanent = permanent + ?, subscription = subscription + ? WHERE user_id = ?')
          .run(reservation.permanent, refundable, reservation.user_id)
      }
      const state = success ? 'consumed' : 'refunded'
      this.db.prepare('UPDATE reservations SET state = ? WHERE job_id = ?').run(state, jobId)
      return state
    })()
  }

  pendingReservations() {
    return this.db.prepare("SELECT * FROM reservations WHERE state = 'reserved'").all()
  }

  createCheckout(id, userId, plan) {
    identifier(id); identifier(userId)
    if (!Object.hasOwn(BILLING_PLANS, plan)) throw new Error('Unknown plan')
    this.ensureAccount(userId)
    this.db.prepare('INSERT INTO checkout_orders VALUES (?, ?, ?, ?)').run(id, userId, plan, Date.now())
  }

  getCheckout(id) {
    return this.db.prepare('SELECT * FROM checkout_orders WHERE id = ?').get(identifier(id))
  }

  applySubscriptionPeriod(checkoutId, providerOrderId, periodStart, periodEnd, status) {
    identifier(providerOrderId)
    if (!Number.isSafeInteger(periodStart) || !Number.isSafeInteger(periodEnd) || periodStart >= periodEnd) {
      throw new Error('Invalid subscription period')
    }
    return this.db.transaction(() => {
      const order = this.getCheckout(checkoutId)
      if (!order || order.plan === 'onetime') throw new Error('Unknown subscription checkout')
      const existing = this.db.prepare('SELECT * FROM test_subscriptions WHERE checkout_id = ?').get(checkoutId)
      if (existing && existing.provider_order_id !== providerOrderId) throw new Error('Subscription order mismatch')
      if (existing && periodStart < existing.period_start) return false
      if (existing && periodStart === existing.period_start) {
        if (periodEnd !== existing.period_end) throw new Error('Subscription period conflict')
        return false
      }
      const other = this.db.prepare('SELECT * FROM test_subscriptions WHERE user_id = ? AND checkout_id != ? AND period_end > ?').get(order.user_id, checkoutId, periodStart)
      if (other) throw new Error('Overlapping subscriptions require reconciliation')
      const grantId = `subscription:${checkoutId}:${periodStart}`
      this.grantSubscription(order.user_id, grantId, {
        plan: order.plan, periodId: grantId, periodStart, periodEnd,
      })
      this.db.prepare(`INSERT INTO test_subscriptions VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(checkout_id) DO UPDATE SET period_start = excluded.period_start,
        period_end = excluded.period_end, status = excluded.status`)
        .run(checkoutId, providerOrderId, order.user_id, order.plan, periodStart, periodEnd, status)
      return true
    })()
  }

  getActiveSubscription(userId, now = Date.now()) {
    return this.db.prepare('SELECT * FROM test_subscriptions WHERE user_id = ? AND period_end > ? ORDER BY period_end DESC LIMIT 1').get(identifier(userId), now)
  }

  recordOneTimePayment(orderId, paymentId) {
    identifier(paymentId)
    return this.db.transaction(() => {
      const order = this.getCheckout(orderId)
      if (!order || order.plan !== 'onetime') throw new Error('Invalid checkout')
      const payment = this.db.prepare('SELECT * FROM payment_ids WHERE id = ?').get(paymentId)
      if (payment && payment.order_id !== orderId) throw new Error('Payment id conflict')
      if (payment) return false
      const previous = this.db.prepare('SELECT id FROM payment_ids WHERE order_id = ?').get(orderId)
      if (previous) throw new Error('Checkout already paid')
      this.db.prepare('INSERT INTO payment_ids VALUES (?, ?)').run(paymentId, orderId)
      this.grantPermanent(order.user_id, `payment:${paymentId}`, BILLING_PLANS.onetime.credits)
      return true
    })()
  }

  holdAccount(userId, reason) {
    identifier(userId)
    this.db.prepare('INSERT OR REPLACE INTO billing_holds VALUES (?, ?)').run(userId, String(reason).slice(0, 500))
  }

  close() { this.db.close() }
}
