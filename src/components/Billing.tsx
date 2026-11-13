import { useEffect, useState } from 'react'
import { getAuthState, subscribeAuth } from '../lib/auth'
import { fetchServiceConfig } from '../lib/api'

type Balance = { total: number; permanent: number; subscription: number; plan: string | null }

const plans = [
  { name: 'One-time', description: 'For the occasional video.', price: '2.90', credits: '300', auto: '5 min', box: null, monthly: false },
  { name: 'Starter', description: 'For a few short videos each month.', price: '4.90', credits: '600', auto: '10 min', box: null, monthly: true },
  { name: 'Pro', description: 'For regular projects and more control.', price: '14.90', credits: '3,600', auto: '60 min', box: '20 min', monthly: true },
  { name: 'Business', description: 'For teams with a larger workload.', price: '39.90', credits: '12,000', auto: '200 min', box: '66 min 40 sec', monthly: true },
]

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
          <p>Choose a one-time package or a monthly plan for your video projects.</p>
          {billingEnabled && <p>{auth.user ? (balance ? `${balance.total} credits available` : 'Loading balance...') : 'Sign in to receive 15 free credits.'}</p>}
        </div>
        {billingEnabled && <span className="billing__badge">Test mode</span>}
      </div>
      <p className="billing__rate">Auto: 1 credit / second <span aria-hidden="true">·</span> Box select: 3 credits / second</p>
      <div className="billing__plans">
        {plans.map((plan) => (
          <article className="billing__plan" key={plan.name}>
            <div className="billing__plan-heading">
              <h2>{plan.name}</h2>
              <p>{plan.description}</p>
              <div className="billing__price">${plan.price}<small>{plan.monthly ? ' / month' : ' one-time'}</small></div>
              <p className="billing__terms">{plan.monthly ? 'Credits reset each billing period and do not roll over.' : 'One-time credits do not expire.'}</p>
            </div>
            <div className="billing__includes">
              <h3>Includes</h3>
              <ul>
                <li>{plan.credits} credits{plan.monthly ? ' / month' : ''}</li>
                <li>Up to {plan.auto} of Auto{plan.box && <> or {plan.box} of Box select</>}</li>
                <li>Automatic subtitle removal</li>
                <li>{plan.box ? 'Manual region selection' : 'Manual selection requires Pro or Business'}</li>
              </ul>
            </div>
            <div className="billing__action">
              {plan.monthly ? <button className="btn btn--ghost" disabled>Coming soon</button> : (
                <button className="btn btn--primary" disabled={!billingEnabled || !auth.user || busy} onClick={() => void checkout()}>
                  {!billingEnabled ? 'Coming soon' : !auth.user ? 'Sign in to continue' : busy ? 'Opening...' : 'Test checkout'}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      <p className="billing__note">Video duration is rounded up to the next whole second. Auto and Box select share the same credit balance.</p>
      {message && <p role="alert">{message}</p>}
    </section>
  )
}
