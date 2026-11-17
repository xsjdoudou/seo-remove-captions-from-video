import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { isRoute } from './src/config'

const DIST = fileURLToPath(new URL('./dist', import.meta.url))
const PUBLIC = fileURLToPath(new URL('./public', import.meta.url))

/**
 * 让 `vite preview` 发出预渲染的页面，而不是一律回退到首页。
 *
 * vite preview 内部用的是 sirv 的 single-page 模式：命中不了的路径直接返回
 * dist/index.html，不会去试 dist/<path>/index.html。结果是 /how-it-works
 * 和 /privacy 全都返回首页的 HTML——title、canonical、正文都是首页的。
 * 本地因此验证不了预渲染，更要命的是万一有人拿 vite preview 当生产服务，
 * 全站每个 URL 都是同一份首页,等于把 SEO 作废。
 *
 * 这里在 fallback 之前把 /how-it-works 改写成 /how-it-works/index.html，
 * 和 deploy/nginx.conf.example 里那条 try_files 的行为对齐。
 */
function prerenderedPages(): Plugin {
  const middleware = (preview: boolean) => (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const raw = req.url ?? '/'
    const queryAt = raw.indexOf('?')
    const pathname = queryAt === -1 ? raw : raw.slice(0, queryAt)
    const query = queryAt === -1 ? '' : raw.slice(queryAt)
    if (pathname === '/' || pathname.startsWith('/@') || pathname.startsWith('/__') || path.extname(pathname)) return next()
    const clean = pathname.replace(/\/+$/, '')
    if (isRoute(clean)) {
      if (pathname.endsWith('/')) {
        res.statusCode = 301
        res.setHeader('Location', `${clean}${query}`)
        res.end()
        return
      }
      req.url = preview ? `${clean}/index.html${query}` : `/index.html${query}`
      return next()
    }
    // Existing extensionless public assets should continue to be served normally.
    const root = preview ? DIST : PUBLIC
    const candidate = path.resolve(root, `.${pathname}`)
    if (candidate.startsWith(root + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return next()
    const html = fs.readFileSync(path.join(preview ? DIST : PUBLIC, '404.html'))
    res.statusCode = 404
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(req.method === 'HEAD' ? undefined : html)
  }
  return {
    name: 'prerendered-pages',
    configureServer(server) {
      server.middlewares.use(middleware(false))
    },
    configurePreviewServer: async (server) => {
      server.middlewares.use(middleware(true))
    },
  }
}

/**
 * 把后端挂进 vite 的 dev / preview server。
 *
 * 本地开发因此只需要 `npm run dev` 一个进程，不用再开一个终端跑 api，
 * 也就不会出现"前端在 5173、后端在 10060、上传 404"这种配置事故。
 * 生产环境不走这里——那边由 nginx 把 /api 和 /s /r 转给独立的 erase-api 进程。
 */
function eraseApi(): Plugin {
  // 顶层 import 会让后端在 `vite build` 时也被加载(从而建 data/ 目录、
  // 读 .env),所以放进 hook 里按需加载。
  //
  // 这两个 hook 必须是 async 并且 **await** mount:vite 会等 configureServer
  // 返回的 promise,然后才挂上自己的 HTML fallback。如果这里只是 fire-and-forget
  // 地发起一个 import(),中间件就会在微任务里晚一步注册,排到 fallback 后面
  // ——表现是 /api/config 和 /r/<token>.mp4 全都返回 index.html,
  // 前端收到一段 HTML 去 JSON.parse,报一个和真实原因毫无关系的错。
  const mount = async (middlewares: { use: (fn: never) => void }) => {
    const { createHandler } = await import('./scripts/erase-api.mjs')
    const { handler } = await createHandler()
    middlewares.use(((req: never, res: never, next: never) => void handler(req, res, next)) as never)
  }

  return {
    name: 'erase-api',
    configureServer: async (server) => {
      await mount(server.middlewares)
    },
    configurePreviewServer: async (server) => {
      await mount(server.middlewares)
    },
  }
}

export default defineConfig({
  appType: 'mpa',
  // eraseApi 排在前面：/api、/s、/r 由它接管，剩下的才轮到页面改写。
  plugins: [react(), eraseApi(), prerenderedPages()],
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  preview: {
    port: 10050,
    host: '127.0.0.1',
  },
  build: {
    // 这个站只有几个页面，拆包反而多几次往返。SEO 看的是首屏，越少请求越好。
    assetsInlineLimit: 4096,
  },
})
