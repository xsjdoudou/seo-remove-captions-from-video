/**
 * 站点常量。
 *
 * 域名、品牌名、联系方式只在这里出现一次——换域名或改品牌时，
 * 不用去 grep 散落在十几个组件和 sitemap 里的硬编码字符串。
 */

export const SITE_URL = 'https://removetextfromvideo.io'
export const SITE_NAME = 'RemoveTextFromVideo'
export const SITE_TAGLINE = 'Remove hardcoded subtitles from video'
export const CONTACT_EMAIL = 'support@removetextfromvideo.io'

/** 站点的全部可索引路由。sitemap 和预渲染都从这里取。 */
export const ROUTES = ['/', '/how-it-works', '/privacy', '/terms'] as const

export type Route = (typeof ROUTES)[number]

export function isRoute(value: string): value is Route {
  return (ROUTES as readonly string[]).includes(value)
}

/** 把路由拼成绝对 URL，canonical 和 og:url 用。 */
export function absoluteUrl(route: string): string {
  return route === '/' ? SITE_URL : `${SITE_URL}${route}`
}
