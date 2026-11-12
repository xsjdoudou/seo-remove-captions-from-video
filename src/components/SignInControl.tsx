import { useEffect, useRef, useState } from 'react'
import { getAuthState, mountGoogleButton, signInWithPassword, signOut, subscribeAuth, type AuthState } from '../lib/auth'

/**
 * 导航栏右侧的登录区。
 *
 * 三种形态：没开登录（什么都不画）、未登录（Google 按钮）、已登录（头像菜单）。
 *
 * 登录在这个站上是**可选**的：不登也能用，登了才有跨设备的历史。所以这块
 * 做得克制——一个按钮，不拦路，没有登录墙。
 */
export default function SignInControl() {
  const [auth, setAuth] = useState<AuthState>(getAuthState)

  useEffect(() => {
    setAuth(getAuthState())
    return subscribeAuth(setAuth)
  }, [])

  // 服务端没配 GOOGLE_CLIENT_ID，或者还没问出结果：不占位、不闪烁。
  // 预渲染出来的 HTML 里本来就没有这块，首帧画一个"登录"再换成头像
  // 会造成一次可见的跳动。
  if (auth.loading) return null
  return auth.user ? <AccountMenu auth={auth} /> : <AuthDialog clientId={auth.clientId} />
}

function AuthDialog({ clientId }: { clientId: string }) {
  const [open, setOpen] = useState(false)
  const [register, setRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (register && password !== confirm) { setError('Passwords do not match.'); return }
    setBusy(true)
    setError('')
    try {
      await signInWithPassword(email, password, register ? confirm : undefined)
      setOpen(false)
      setPassword('')
      setConfirm('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.')
    } finally { setBusy(false) }
  }

  return (
    <div className="auth">
      <button className="btn btn--ghost btn--sm" type="button" onClick={() => setOpen(true)}>Sign in</button>
      {open && (
        <div className="auth-dialog__backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setOpen(false) }}>
          <section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
            <button className="auth-dialog__close" type="button" aria-label="Close" title="Close" onClick={() => setOpen(false)}>×</button>
            <h2 id="auth-title">{register ? 'Create account' : 'Sign in'}</h2>
            {clientId && <GoogleButton />}
            <form onSubmit={(event) => void submit(event)}>
              <label>Email<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
              <label>Password<input type="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={8} maxLength={200} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
              {register && <label>Confirm password<input type="password" autoComplete="new-password" required minLength={8} maxLength={200} value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>}
              {error && <p className="auth-dialog__error" role="alert">{error}</p>}
              <button className="btn btn--primary" type="submit" disabled={busy}>{busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}</button>
            </form>
            <button className="auth-dialog__switch" type="button" onClick={() => { setRegister(!register); setError(''); setConfirm('') }}>
              {register ? 'Already have an account? Sign in' : 'New here? Create an account'}
            </button>
          </section>
        </div>
      )}
    </div>
  )
}

function GoogleButton() {
  const slot = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const node = slot.current
    if (!node) return
    let cancelled = false
    void mountGoogleButton(node, {
      onError: (message) => {
        if (!cancelled) setError(message)
      },
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load Google sign-in.')
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="auth">
      {/* GIS 自己往这个节点里塞 iframe；它的尺寸由 renderButton 的参数决定。 */}
      <div ref={slot} className="auth__google" />
      {error && (
        <p className="auth__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function AccountMenu({ auth }: { auth: AuthState }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const user = auth.user!

  // 点菜单外面、或者按 Esc，都该把它关掉。少了这两条，菜单会一直挂在那里，
  // 用户得再点一次按钮才关得掉。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const label = user.name || user.email || 'Account'

  return (
    <div className="auth auth--account" ref={wrap}>
      <button
        type="button"
        className="auth__trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Avatar user={user} />
        <span className="auth__name">{label}</span>
      </button>

      {open && (
        <div className="auth__menu" role="menu">
          <div className="auth__identity">
            <Avatar user={user} />
            <div className="auth__identityText">
              <p className="auth__identityName">{label}</p>
              {user.email && <p className="auth__identityEmail">{user.email}</p>}
            </div>
          </div>
          <button
            type="button"
            className="auth__signout"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              void signOut()
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

function Avatar({ user }: { user: { name: string; email: string; picture: string } }) {
  const [broken, setBroken] = useState(false)
  // Google 的头像地址会失效（用户换了头像、或者带的尺寸参数过期）。
  // 坏掉时退回首字母，而不是留一个碎图标。
  if (user.picture && !broken) {
    return (
      <img
        className="auth__avatar"
        src={user.picture}
        alt=""
        width={24}
        height={24}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    )
  }
  const initial = (user.name || user.email || '?').trim().charAt(0).toUpperCase()
  return (
    <span className="auth__avatar auth__avatar--letter" aria-hidden="true">
      {initial}
    </span>
  )
}
