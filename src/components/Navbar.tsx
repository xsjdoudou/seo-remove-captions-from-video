import { LogoIcon } from './icons'
import { SITE_NAME } from '../config'
import SignInControl from './SignInControl'

/**
 * 导航栏。
 *
 * 站内链接必须是真的 <a href>，不能是 onClick 的 <div>：爬虫沿着 href 抓,
 * 用户也要能中键在新标签页打开。onClick 只是拦下来走前端路由,
 * 带修饰键的点击仍然放行给浏览器。
 */
export default function Navbar({ route, onNavigate }: { route: string; onNavigate: (to: string) => void }) {
  return (
    <header className="navbar">
      <div className="navbar__inner">
        <NavLink href="/" onNavigate={onNavigate} className="navbar__brand">
          <LogoIcon className="navbar__logo" />
          <span>{SITE_NAME}</span>
        </NavLink>
        <nav className="navbar__links" aria-label="Main">
          <NavLink href="/" onNavigate={onNavigate} className={route === '/' ? 'is-current' : ''}>
            Remove text
          </NavLink>
          <NavLink href="/how-it-works" onNavigate={onNavigate} className={route === '/how-it-works' ? 'is-current' : ''}>
            How it works
          </NavLink>
          <a className="btn btn--primary btn--sm" href="/#tool" onClick={() => onNavigate('/')}>
            Try it free
          </a>
          {/* 登录排在 CTA 右边：主按钮仍然是"开始用"，登录只是给回头客的入口。 */}
          <SignInControl />
        </nav>
      </div>
    </header>
  )
}

export function NavLink({
  href,
  onNavigate,
  className,
  children,
}: {
  href: string
  onNavigate: (to: string) => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        // Ctrl/Cmd/中键点击、新窗口这些交给浏览器原生行为,别劫持。
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
        event.preventDefault()
        onNavigate(href)
      }}
    >
      {children}
    </a>
  )
}
