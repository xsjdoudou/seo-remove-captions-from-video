/**
 * 每个路由的 SEO 元信息与结构化数据。
 *
 * 浏览器端在导航时用它更新 document.title / meta；
 * 构建期 scripts/build-canonical-pages.mjs 用同一份数据把 title、description、
 * canonical、JSON-LD 直接写进静态 HTML。两边共用一个来源，不会出现
 * "浏览器里标题是对的，爬虫看到的是默认值"这种偏差。
 */

import { SITE_NAME, SITE_URL, absoluteUrl, type Route } from './config'

export interface PageMeta {
  title: string
  description: string
  /** 页面级 JSON-LD。站点级的 WebSite/SoftwareApplication 在 siteSchema 里。 */
  schema?: Record<string, unknown>[]
}

export const FAQ: { q: string; a: string }[] = [
  {
    q: 'Can you remove hardcoded subtitles that are burned into the video?',
    a: 'Yes — this is what the tool is built for. Burned-in subtitles are pixels, not a separate track, so they cannot simply be switched off. The AI detects the subtitle region frame by frame, removes the lettering and reconstructs the background behind it from surrounding frames, so you get a clean picture instead of a blur box.',
  },
  {
    q: 'Which text on screen gets removed?',
    a: 'The detector looks for subtitle-style text — the caption band across the lower and central part of the frame. Burned-in subtitles, open captions, translated subtitles and lower-third captions are all handled. Text pinned to the very top edge of the frame, such as a scrolling news banner, and small corner logos are outside what the subtitle model targets and will usually survive.',
  },
  {
    q: 'Does it remove watermarks and logos?',
    a: 'Not reliably. The model is tuned for subtitles, so a corner watermark or a channel bug often stays. If a logo sits inside the caption area it may be picked up, but do not count on it — if watermark removal is what you need, this is not the right tool yet.',
  },
  {
    q: 'Do I need to install anything?',
    a: 'No. Everything runs in your browser and on our servers, with nothing to download or install. Sign in with Google or an email account to process videos and access your history across devices. New accounts receive 15 free credits when credit billing is enabled.',
  },
  {
    q: 'What video formats are supported?',
    a: 'MP4, MOV, M4V, WebM, MKV, AVI, FLV, WMV and TS. The processed video always comes back as MP4, which plays everywhere.',
  },
  {
    q: 'How long does processing take?',
    a: 'Expect a few minutes for a short clip — a two-and-a-half minute video takes around five minutes in our testing. Every frame has to be repainted, so longer and higher-resolution videos take proportionally longer.',
  },
  {
    q: 'Is my video kept private?',
    a: 'Your upload is used for one thing only: producing your result. The original is deleted as soon as the result is ready, both files are gone within 24 hours, and nothing is shared, published or used for training.',
  },
  {
    q: 'Will the video quality drop?',
    a: 'Only the area where subtitles were found gets repainted; the rest of each frame is left alone. Resolution and frame rate are preserved — the video is re-encoded once, as any export would be.',
  },
  {
    q: 'Does it work on subtitles in any language?',
    a: 'Yes. Latin, Chinese, Japanese, Korean, Arabic, Cyrillic and Thai lettering are all treated the same way — as pixels to remove, not words to read.',
  },
  {
    q: 'Does it work on moving or changing subtitles?',
    a: 'Yes, detection runs per frame, so subtitles that change line, fade in or shift position are tracked rather than averaged into one static box.',
  },
]

const HOME_META: PageMeta = {
  title: `Remove Subtitles From Video Online — Free AI Hardcoded Caption Remover | ${SITE_NAME}`,
  description:
    'Remove hardcoded subtitles and burned-in captions from video online. The AI repaints the background instead of blurring or cropping it. No watermark, free credits for new accounts.',
  schema: [
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: FAQ.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'HowTo',
      name: 'How to remove hardcoded subtitles from a video',
      description: 'Remove burned-in subtitles and captions from a video in three steps.',
      totalTime: 'PT5M',
      step: [
        {
          '@type': 'HowToStep',
          name: 'Upload your video',
          text: 'Drag your file onto the upload area, or click to pick one. MP4, MOV, WebM, MKV and more are accepted.',
        },
        {
          '@type': 'HowToStep',
          name: 'Let the AI erase the subtitles',
          text: 'The subtitle region is detected frame by frame and the background behind it is reconstructed from surrounding frames.',
        },
        {
          '@type': 'HowToStep',
          name: 'Download the clean video',
          text: 'Preview the result in your browser and download it as an MP4. No watermark is added.',
        },
      ],
    },
  ],
}

const META: Record<Route, PageMeta> = {
  '/': HOME_META,
  '/how-it-works': {
    title: `How AI Subtitle Removal Works — Inpainting Explained | ${SITE_NAME}`,
    description:
      'A plain-English walkthrough of how burned-in subtitles are removed from video: text detection, masking, and temporal inpainting that rebuilds the background behind the letters.',
  },
  '/pricing': {
    title: `Pricing | ${SITE_NAME}`,
    description: 'Compare credit packages and monthly plans for removing subtitles from video.',
  },
  '/privacy': {
    title: `Privacy Policy | ${SITE_NAME}`,
    description: `How ${SITE_NAME} handles the videos you upload: what is stored, for how long, and what is never done with your files.`,
  },
  '/terms': {
    title: `Terms of Service | ${SITE_NAME}`,
    description: `The terms that apply when you use ${SITE_NAME} to remove text from your videos.`,
  },
}

export function metaFor(route: Route): PageMeta {
  return META[route] ?? HOME_META
}

/** 站点级结构化数据，每个页面都带上。 */
export function siteSchema(): Record<string, unknown>[] {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE_NAME,
      url: SITE_URL,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: SITE_NAME,
      applicationCategory: 'MultimediaApplication',
      operatingSystem: 'Any (web-based)',
      url: SITE_URL,
      description:
        'Online AI tool that removes hardcoded subtitles and burned-in captions from video by reconstructing the background behind them.',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
  ]
}

/**
 * 客户端路由切换时同步 <head>。
 *
 * 预渲染出来的 HTML 已经带了正确的标签，这里做的是单页导航之后的更新——
 * 爬虫看的是前者，用户分享链接时的预览卡片看的也是前者，这个函数只影响
 * 浏览器标签页标题和已经在站内点过几下的用户。
 */
export function applyMeta(route: Route): void {
  if (typeof document === 'undefined') return
  const meta = metaFor(route)
  document.title = meta.title
  setTag('meta[name="description"]', 'content', meta.description)
  setTag('link[rel="canonical"]', 'href', absoluteUrl(route))
  setTag('meta[property="og:title"]', 'content', meta.title)
  setTag('meta[property="og:description"]', 'content', meta.description)
  setTag('meta[property="og:url"]', 'content', absoluteUrl(route))
}

function setTag(selector: string, attribute: string, value: string): void {
  const element = document.head.querySelector(selector)
  if (element) element.setAttribute(attribute, value)
}
