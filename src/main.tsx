import { StrictMode } from 'react'
import { hydrateRoot, createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('missing #root')

// 预渲染出来的页面带着真实 HTML，必须 hydrate 而不是 createRoot：
// 后者会先把服务端渲染的内容整个清空再重建，首屏会闪一下白。
// dev 模式下 index.html 里是空壳，走 createRoot。
if (container.hasChildNodes()) {
  hydrateRoot(
    container,
    <StrictMode>
      <App />
    </StrictMode>,
  )
} else {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
