import { useEffect, useState } from 'react'
import { getAuthState, subscribeAuth } from '../lib/auth'

type Balance = { total: number; permanent: number; subscription: number; plan: string | null }

export default function Billing() {
  const [auth, setAuth] = useState(getAuthState)
  const [balance, setBalance] = useState<Balance | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => subscribeAuth(setAuth), [])
  useEffect(() => {
    let active = true
    if (!auth.user) { setBalance(null); return }
    fetch('/api/billing/account').then(async (response) => {
      if (!response.ok) throw new Error('Could not load your balance.')
      return response.json() as Promise<{ balance: Balance }>
    }).then((data) => { if (active) setBalance(data.balance) })
      .catch(() => { if (active) setMessage('Could not load your balance.') })
    return () => { active = false }
  }, [auth.user])

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
    <section className="billing" aria-label="Credits">
      <div className="billing__header">
        <div>
          <h2>Credits</h2>
          <p>{auth.user ? (balance ? `${balance.total} credits available` : 'Loading balance...') : 'Sign in to receive 15 free credits.'}</p>
        </div>
        <span className="billing__badge">Test mode</span>
      </div>
      <div className="billing__plans">
        <div><strong>One-time</strong><span>$2.90</span><small>300 credits</small>
          <button className="btn btn--primary btn--sm" disabled={!auth.user || busy} onClick={() => void checkout()}>
            {busy ? 'Opening...' : 'Buy credits'}
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
