import { useEffect, useState } from 'react'
import { fetchServiceConfig } from '../lib/api'
import { getAuthState, subscribeAuth } from '../lib/auth'

type CreditState = 'loading' | 'disabled' | 'signed-out' | 'unavailable' | number

export default function CreditStatus({ onNavigate }: { onNavigate: (to: string) => void }) {
  const [auth, setAuth] = useState(getAuthState)
  const [credits, setCredits] = useState<CreditState>('loading')

  useEffect(() => subscribeAuth(setAuth), [])
  useEffect(() => {
    let active = true
    let request = 0
    setCredits('loading')

    const refresh = async () => {
      const current = ++request
      try {
        const config = await fetchServiceConfig()
        if (!active || current !== request) return
        if (config.billingEnabled === false) { setCredits('disabled'); return }
        if (config.billingEnabled !== true) throw new Error('Billing status unavailable')
        if (!auth.user) { setCredits('signed-out'); return }
        const response = await fetch('/api/billing/account', { headers: { accept: 'application/json' }, cache: 'no-store' })
        if (!response.ok) throw new Error('Balance unavailable')
        const data = await response.json() as { balance?: { total?: unknown } }
        if (!Number.isSafeInteger(data.balance?.total) || (data.balance?.total as number) < 0) throw new Error('Invalid balance')
        if (active && current === request) setCredits(data.balance?.total as number)
      } catch {
        if (active && current === request) setCredits('unavailable')
      }
    }

    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh() }
    void refresh()
    window.addEventListener('credits-changed', refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    const timer = window.setInterval(onVisibility, 30000)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('credits-changed', refresh)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [auth.user])

  if (credits === 'loading') return null
  const label = typeof credits === 'number' ? `${credits.toLocaleString()} credits`
    : credits === 'disabled' ? 'Free processing'
    : credits === 'signed-out' ? 'Sign in for credits'
    : 'Credits unavailable'
  const title = credits === 'disabled'
    ? 'Billing is currently disabled. Processing does not use credits.'
    : credits === 'unavailable' ? 'Could not load credit information.'
    : 'View pricing'

  return (
    <a href="/pricing" className="credit-status" title={title} onClick={(event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
      event.preventDefault()
      onNavigate('/pricing')
    }}>{label}</a>
  )
}
