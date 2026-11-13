import { useCallback, useEffect, useState } from 'react'
import { isRoute, type Route } from './config'
import { applyMeta } from './seo'
import { fetchServiceConfig } from './lib/api'
import { initAuth, subscribeAuth } from './lib/auth'
import { enterLocalMode, enterServerMode } from './lib/history'
import Navbar from './components/Navbar'
import Footer from './components/Footer'
import HomePage from './components/HomePage'
import HowItWorksPage from './components/HowItWorksPage'
import Billing from './components/Billing'
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

  /**
   * 登录状态驱动历史记录从哪儿读。
   *
   * 放在 App 这一层而不是 HistoryList 里：侧栏可以被收起，而收起时组件
   * 仍然挂载着——真正的原因是这个切换关系到全站的数据来源，不是某个
   * 组件的内部状态。登录态一变，整个列表就要换一边。
   */
  useEffect(() => {
    let cancelled = false
    let signedIn = false

    const unsubscribe = subscribeAuth((state) => {
      if (cancelled || state.loading) return
      const nowSignedIn = state.user !== null
      if (nowSignedIn === signedIn) return
      signedIn = nowSignedIn
      if (nowSignedIn) {
        // 认领失败也不该把界面卡在旧状态上——退回本地模式，用户至少
        // 还能看到这台浏览器里的记录。
        void enterServerMode().catch(() => enterLocalMode())
      } else {
        enterLocalMode()
      }
    })

    void (async () => {
      // client id 和服务限额来自同一个接口，顺带拿到。拿不到就当没开登录：
      // 匿名流程完全不依赖它。
      const clientId = await fetchServiceConfig()
        .then((config) => config.googleClientId)
        .catch(() => '')
      if (!cancelled) await initAuth(clientId)
    })()

    return () => {
      cancelled = true
      unsubscribe()
    }
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
        {route === '/pricing' && <Billing />}
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
