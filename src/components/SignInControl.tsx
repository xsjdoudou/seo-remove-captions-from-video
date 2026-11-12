import { useEffect, useRef, useState } from 'react'
import { getAuthState, mountGoogleButton, signOut, subscribeAuth, type AuthState } from '../lib/auth'

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
  if (!auth.clientId || auth.loading) return null
  return auth.user ? <AccountMenu auth={auth} /> : <GoogleButton />
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
