import { useEffect, useState } from 'react'
import { getAuthState, subscribeAuth } from '../lib/auth'
import { fetchServiceConfig } from '../lib/api'

type Balance = { total: number; permanent: number; subscription: number; plan: string | null }

export default function Billing() {
  const [auth, setAuth] = useState(getAuthState)
  const [balance, setBalance] = useState<Balance | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [billingEnabled, setBillingEnabled] = useState(false)

  useEffect(() => subscribeAuth(setAuth), [])
  useEffect(() => {
    let active = true
    void fetchServiceConfig().then((config) => {
      if (active) setBillingEnabled(Boolean(config.billingEnabled))
    }).catch(() => {})
    return () => { active = false }
  }, [])
  useEffect(() => {
    let active = true
    if (!auth.user || !billingEnabled) { setBalance(null); return }
    fetch('/api/billing/account').then(async (response) => {
      if (!response.ok) throw new Error('Could not load your balance.')
      return response.json() as Promise<{ balance: Balance }>
    }).then((data) => { if (active) setBalance(data.balance) })
      .catch(() => { if (active) setMessage('Could not load your balance.') })
    return () => { active = false }
  }, [auth.user, billingEnabled])

  async function checkout() {
    setBusy(true)
    setMessage('')
    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planId: 'onetime' }),
      })
      const result = await response.json() as { checkoutUrl?: string; error?: { message?: string } }
      if (!response.ok || !result.checkoutUrl) throw new Error(result.error?.message || 'Checkout is unavailable.')
      window.location.assign(result.checkoutUrl)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Checkout is unavailable.')
      setBusy(false)
    }
  }

  return (
    <section className="billing" aria-label="Pricing">
      <div className="billing__header">
        <div>
          <h1>Pricing</h1>
          <p>Choose the credits that fit your video projects.</p>
          {billingEnabled && <p>{auth.user ? (balance ? `${balance.total} credits available` : 'Loading balance...') : 'Sign in to receive 15 free credits.'}</p>}
        </div>
        {billingEnabled && <span className="billing__badge">Test mode</span>}
      </div>
      <div className="billing__plans">
        <div><strong>One-time</strong><span>$2.90</span><small>300 credits</small>
          <button className="btn btn--primary btn--sm" disabled={!billingEnabled || !auth.user || busy} onClick={() => void checkout()}>
            {!billingEnabled ? 'Coming soon' : !auth.user ? 'Sign in to continue' : busy ? 'Opening...' : 'Test checkout'}
          </button>
        </div>
        <div><strong>Starter</strong><span>$4.90 / month</span><small>600 credits / month</small><small>Coming soon</small></div>
        <div><strong>Pro</strong><span>$14.90 / month</span><small>3,600 credits / month</small><small>Coming soon</small></div>
        <div><strong>Business</strong><span>$39.90 / month</span><small>12,000 credits / month</small><small>Coming soon</small></div>
      </div>
      {message && <p role="alert">{message}</p>}
    </section>
  )
}
