import { useCallback, useEffect, useState } from 'react'
import { isRoute, type Route } from './config'
import { applyMeta } from './seo'
import Navbar from './components/Navbar'
import Footer from './components/Footer'
import HomePage from './components/HomePage'
import HowItWorksPage from './components/HowItWorksPage'
import { PrivacyPage, TermsPage } from './components/LegalPage'

/**
 * 路由。
 *
 * 四个静态页面，用 history API 自己接就够了,不值得为此引入 react-router
 * ——那是 50KB 的 JS，而这个站的卖点之一就是打开得快。
 */
export default function App({ initialRoute = '/' }: { initialRoute?: string }) {
  const [route, setRoute] = useState<Route>(() => normalize(initialRoute))

  // 预渲染时 initialRoute 由构建脚本给；浏览器里首次挂载要以地址栏为准，
  // 否则用户直接打开 /how-it-works 会看到首页内容。
  useEffect(() => {
    const current = normalize(window.location.pathname)
    if (current !== route) setRoute(current)
    const onPopState = () => setRoute(normalize(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
    // 只在挂载时跑一次：之后的变化由 navigate 和 popstate 负责。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    applyMeta(route)
  }, [route])

  const navigate = useCallback((next: string) => {
    const target = normalize(next)
    window.history.pushState({}, '', target)
    setRoute(target)
    window.scrollTo({ top: 0 })
  }, [])

  return (
    <div className="shell">
      <Navbar route={route} onNavigate={navigate} />
      <main id="main">
        {route === '/' && <HomePage onNavigate={navigate} />}
        {route === '/how-it-works' && <HowItWorksPage onNavigate={navigate} />}
        {route === '/privacy' && <PrivacyPage />}
        {route === '/terms' && <TermsPage />}
      </main>
      <Footer onNavigate={navigate} />
    </div>
  )
}

/** 未知路径落回首页，而不是显示空白——SEO 上一个空页面比重定向更糟。 */
function normalize(pathname: string): Route {
  const trimmed = pathname.replace(/\/+$/, '') || '/'
  return isRoute(trimmed) ? trimmed : '/'
}
