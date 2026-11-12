/**
 * 登录状态。
 *
 * 浏览器这边不持有任何凭证——会话在一个 HttpOnly 的 cookie 里，JS 读不到它。
 * 这里保存的只是"当前是谁"这份资料，用来决定导航栏画什么、历史从哪里读。
 * 真正的权限判断全在服务端。
 *
 * Google 那边走 Identity Services（GIS）：脚本按需加载，没点登录的访客
 * 不会因为这个功能多下载一个字节，也不会被 Google 看到一次请求。
 */

import { fetchSession, passwordAuth, signInWithGoogle, signOut as signOutRequest, type User } from './api'

export type { User }

export interface AuthState {
  user: User | null
  /** 还没问过服务端。首帧据此不闪一下"未登录"。 */
  loading: boolean
  /** Google 客户端 ID；未配置时邮箱登录仍然可用。 */
  clientId: string
}

let state: AuthState = { user: null, loading: true, clientId: '' }
type Listener = (state: AuthState) => void
const listeners = new Set<Listener>()

export function getAuthState(): AuthState {
  return state
}

export function subscribeAuth(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function setState(patch: Partial<AuthState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener(state)
}

/** 页面加载后问一次服务端"我是谁"。clientId 由调用方从 /api/config 带进来。 */
export async function initAuth(clientId: string): Promise<void> {
  setState({ clientId })
  try {
    setState({ user: await fetchSession(), loading: false })
  } catch {
    // 问不到就当未登录。登录是附加功能，它不可用不该挡住主流程。
    setState({ user: null, loading: false })
  }
}

export async function signInWithPassword(email: string, password: string, confirmPassword?: string): Promise<void> {
  setState({ user: await passwordAuth(email, password, confirmPassword) })
}

// ── Google Identity Services ────────────────────────────────────────────

interface GoogleIdentity {
  accounts: {
    id: {
      initialize(options: { client_id: string; callback: (response: { credential?: string }) => void }): void
      renderButton(parent: HTMLElement, options: Record<string, unknown>): void
      disableAutoSelect(): void
    }
  }
}

declare global {
  interface Window {
    google?: GoogleIdentity
  }
}

const GIS_SRC = 'https://accounts.google.com/gsi/client'
let gisPromise: Promise<GoogleIdentity> | null = null

/**
 * 按需加载 GIS 脚本。
 *
 * 不写在 index.html 里：那会让每一个访客——包括从来不打算登录的那 95%——
 * 都向 Google 发一次请求，而这个站的隐私页写着"不跑第三方追踪脚本"。
 * 只有真的要登录的人才会把它拉下来。
 */
function loadGoogleIdentity(): Promise<GoogleIdentity> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google)
  if (gisPromise) return gisPromise

  gisPromise = new Promise<GoogleIdentity>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`)
    const script = existing ?? document.createElement('script')
    const onLoad = () => {
      if (window.google?.accounts?.id) resolve(window.google)
      else reject(new Error('Google sign-in loaded but is not usable.'))
    }
    script.addEventListener('load', onLoad)
    script.addEventListener('error', () => {
      // 下次点击要能重试：失败的 promise 留在缓存里会让按钮永远点不动。
      gisPromise = null
      reject(new Error('Could not load Google sign-in. Check your connection or any blockers.'))
    })
    if (!existing) {
      script.src = GIS_SRC
      script.async = true
      script.defer = true
      document.head.appendChild(script)
    }
  })
  return gisPromise
}

/**
 * 在给定容器里渲染 Google 官方的登录按钮。
 *
 * 必须用它渲染，不能自己画一个按钮再调 API：GIS 的凭证流程绑定在这个
 * 按钮的点击上，而且 Google 的品牌规范要求用他们的样式。
 */
export async function mountGoogleButton(
  container: HTMLElement,
  { onError }: { onError?: (message: string) => void } = {},
): Promise<void> {
  if (!state.clientId) return
  const google = await loadGoogleIdentity()

  google.accounts.id.initialize({
    client_id: state.clientId,
    callback: (response) => {
      void (async () => {
        if (!response.credential) {
          onError?.('Google did not return a sign-in token.')
          return
        }
        try {
          const user = await signInWithGoogle(response.credential)
          setState({ user })
        } catch (err) {
          onError?.(err instanceof Error ? err.message : 'Sign-in failed.')
        }
      })()
    },
  })

  container.replaceChildren()
  google.accounts.id.renderButton(container, {
    type: 'standard',
    theme: 'outline',
    size: 'medium',
    shape: 'pill',
    text: 'signin',
  })
}

export async function signOut(): Promise<void> {
  await signOutRequest()
  setState({ user: null })
  // 不调这一句的话，One Tap 会在下一次加载时把刚登出的账号自动选回来，
  // 用户会觉得登出按钮没生效。
  window.google?.accounts?.id?.disableAutoSelect()
}
