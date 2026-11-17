/**
 * 预渲染入口。
 *
 * `vite build --ssr` 把这个文件打成一个 Node 模块,
 * scripts/build-canonical-pages.mjs 对每个路由调一次 render(),
 * 把结果塞进 dist/index.html 的 <div id="root"> 里,生成静态页面。
 *
 * 这样爬虫第一次 GET 就能拿到完整正文,不依赖它执不执行 JS。
 *
 * SEO 数据也从这里再导出一遍:构建脚本就只需要加载一个模块,
 * 而且拿到的和浏览器端用的是同一份常量,不会两边对不上。
 */

import { renderToString } from 'react-dom/server'
import App from './App'
import Navbar from './components/Navbar'
import Footer from './components/Footer'

export function render(route: string): string {
  return renderToString(<App initialRoute={route} />)
}

export function renderNotFound(stylesheetHref: string): string {
  const href = stylesheetHref.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const body = renderToString(
    <div className="shell">
      <Navbar route="" onNavigate={() => {}} />
      <main id="main">
        <section className="section">
          <h1>This page doesn&apos;t exist</h1>
          <a href="/">Return to the home page</a>
        </section>
      </main>
      <Footer onNavigate={() => {}} />
    </div>,
  )
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Page not found — RemoveTextFromVideo</title>
  <link rel="stylesheet" href="${href}" />
</head>
<body>${body}</body>
</html>
`
}

export { ROUTES, SITE_URL, SITE_NAME, absoluteUrl } from './config'
export { metaFor, siteSchema } from './seo'
