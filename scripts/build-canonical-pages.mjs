#!/usr/bin/env node
// 预渲染：把每个路由渲成一个带完整正文的静态 HTML 文件。
//
//   dist/index.html
//   dist/how-it-works/index.html
//   dist/privacy/index.html
//   dist/terms/index.html
//
// 为什么非做不可：这是个靠搜索流量活的站。一个只有 <div id="root"></div> 的
// 页面,爬虫要排队等渲染才能看到内容,而且不是每个爬虫都会渲染。预渲染之后
// 第一次 GET 返回的就是完整的文字、标题和 JSON-LD。
//
// 同时也顺手生成 sitemap.xml —— 让路由清单只有一处来源,
// 不会出现"加了新页面但忘了加进 sitemap"。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIST = path.join(ROOT, 'dist')
const PRERENDER = path.join(ROOT, '.prerender')

// 构建产物缺失时给一句能看懂的话,而不是一串模块解析失败。
if (!fs.existsSync(DIST)) throw new Error('dist/ is missing — run `vite build` before this script')
if (!fs.existsSync(PRERENDER)) throw new Error('.prerender/ is missing — run `vite build --ssr` before this script')

// entry-server 把渲染函数和 SEO 数据一并再导出,这里只认它一个入口。
const { render, ROUTES, SITE_URL, absoluteUrl, metaFor, siteSchema } = await import(
  path.join(PRERENDER, 'entry-server.js')
)

const template = await fsp.readFile(path.join(DIST, 'index.html'), 'utf8')

for (const route of ROUTES) {
  const meta = metaFor(route)
  const canonical = absoluteUrl(route)
  const schema = [...siteSchema(), ...(meta.schema ?? [])]

  let html = template
  html = replaceTag(html, /<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(meta.title)}</title>`)
  html = replaceAttr(html, 'meta[name=description]', /(<meta\s+name="description"\s+content=")[\s\S]*?(")/, meta.description)
  html = replaceAttr(html, 'link[rel=canonical]', /(<link\s+rel="canonical"\s+href=")[\s\S]*?(")/, canonical)
  html = replaceAttr(html, 'meta[og:title]', /(<meta\s+property="og:title"\s+content=")[\s\S]*?(")/, meta.title)
  html = replaceAttr(html, 'meta[og:description]', /(<meta\s+property="og:description"\s+content=")[\s\S]*?(")/, meta.description)
  html = replaceAttr(html, 'meta[og:url]', /(<meta\s+property="og:url"\s+content=")[\s\S]*?(")/, canonical)

  // JSON-LD。首页的那几块由 HomePage 组件自己渲染出来了,别重复插一遍。
  if (route !== '/') {
    const blocks = schema
      .map((block) => `    <script type="application/ld+json">${jsonForHtml(block)}</script>`)
      .join('\n')
    html = html.replace('</head>', `${blocks}\n  </head>`)
  }

  html = html.replace('<div id="root"></div>', `<div id="root">${render(route)}</div>`)

  const outDir = route === '/' ? DIST : path.join(DIST, route.replace(/^\//, ''))
  await fsp.mkdir(outDir, { recursive: true })
  await fsp.writeFile(path.join(outDir, 'index.html'), html)
  console.log(`[prerender] ${route} → ${path.relative(ROOT, path.join(outDir, 'index.html'))}`)
}

await fsp.writeFile(path.join(DIST, 'sitemap.xml'), sitemap(ROUTES, absoluteUrl))
console.log('[prerender] sitemap.xml')

await fsp.writeFile(path.join(DIST, 'robots.txt'), robots(SITE_URL))
console.log('[prerender] robots.txt')

// .prerender 是中间产物,留着只会让下次构建读到上一次的陈旧代码。
await fsp.rm(PRERENDER, { recursive: true, force: true })


/** 替换必须真的命中,否则 index.html 改了格式之后会静默地渲染出错的元信息。 */
function replaceTag(html, pattern, replacement) {
  if (!pattern.test(html)) throw new Error(`prerender: index.html is missing ${pattern}`)
  return html.replace(pattern, replacement)
}

function replaceAttr(html, label, pattern, value) {
  if (!pattern.test(html)) throw new Error(`prerender: index.html is missing ${label}`)
  return html.replace(pattern, `$1${escapeAttr(value)}$2`)
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;')
}

/** JSON-LD 里的 `</script>` 会提前结束脚本标签,必须转义掉。 */
function jsonForHtml(block) {
  return JSON.stringify(block).replace(/</g, '\\u003c')
}

function sitemap(routes, toUrl) {
  const today = new Date().toISOString().slice(0, 10)
  const entries = routes
    .map((route) => {
      // 首页是入口,优先级最高;法务页给搜索引擎的价值最低。
      const priority = route === '/' ? '1.0' : route === '/how-it-works' ? '0.8' : '0.3'
      return [
        '  <url>',
        `    <loc>${toUrl(route)}</loc>`,
        `    <lastmod>${today}</lastmod>`,
        `    <priority>${priority}</priority>`,
        '  </url>',
      ].join('\n')
    })
    .join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries,
    '</urlset>',
    '',
  ].join('\n')
}

function robots(siteUrl) {
  return [
    'User-agent: *',
    'Allow: /',
    // /s/ 和 /r/ 下面是用户的私有文件,URL 本身就是访问凭证。
    // 爬虫不该去抓,日志里也不该出现它们。
    'Disallow: /s/',
    'Disallow: /r/',
    'Disallow: /api/',
    '',
    `Sitemap: ${siteUrl}/sitemap.xml`,
    '',
  ].join('\n')
}
