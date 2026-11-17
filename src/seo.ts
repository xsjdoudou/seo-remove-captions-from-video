/**
 * 每个路由的 SEO 元信息与结构化数据。
 *
 * 浏览器端在导航时用它更新 document.title / meta；
 * 构建期 scripts/build-canonical-pages.mjs 用同一份数据把 title、description、
 * canonical、JSON-LD 直接写进静态 HTML。两边共用一个来源，不会出现
 * "浏览器里标题是对的，爬虫看到的是默认值"这种偏差。
 */

import { SITE_NAME, SITE_URL, absoluteUrl, type Route } from './config'

const SHARED_OG_IMAGE = `${SITE_URL}/demo/share-comparison.jpg`

export interface PageMeta {
  title: string
  description: string
  image?: string
  /** 页面级 JSON-LD。站点级的 WebSite/SoftwareApplication 在 siteSchema 里。 */
  schema?: Record<string, unknown>[]
}

export const CAPTIONS_FAQ: { q: string; a: string }[] = [
  {
    q: 'Can I remove auto-generated captions from a TikTok or Reels export?',
    a: 'Yes, if the captions are visible in the exported picture, the tool can attempt to erase them. Results depend on the background and caption placement, so preview the processed clip before sharing it.',
  },
  {
    q: 'Can it handle captions that pop up or appear word by word?',
    a: 'The automatic mode examines frames as the text changes, including words that appear one at a time. Fast animations, unusual placements, or busy backgrounds can be harder to reconstruct cleanly.',
  },
  {
    q: 'Will a separate subtitle track remain after processing?',
    a: 'Do not rely on a separate subtitle track being preserved in the output MP4. Keep the original file and its subtitle track, and add the track back in your video editor if you need it.',
  },
  {
    q: 'Will removing captions reduce video quality?',
    a: 'The output is re-encoded, so some quality change is possible even when you keep the original resolution. You can choose a lower available resolution to use fewer credits; inspect the reconstructed area for artifacts.',
  },
  {
    q: 'Do I need to install software or create an account?',
    a: 'There is no editor or plugin to install. Sign in with Google or email to remove captions from video; new accounts receive 15 free credits.',
  },
]

const CAPTIONS_DESCRIPTION = 'Remove captions from video with AI. Burned-in captions are pixels; rebuild the background without blur or cropping. Free to try.'

export const SUBTITLES_FAQ: { q: string; a: string }[] = [
  {
    q: 'How can I tell whether the subtitles are part of the picture?',
    a: 'Turn subtitles off in your player or inspect the tracks in your editing project. If the words remain visible when every subtitle track is disabled, they are probably embedded in the image.',
  },
  {
    q: 'Can I erase subtitles for only part of a video?',
    a: 'The tool does not offer a time-range control for removal. To restrict the edit, split the video in an editor, process only the relevant segment, and join the clips afterward.',
  },
  {
    q: 'Will the original subtitle track remain in the result?',
    a: 'Separate tracks are not guaranteed to be included in the exported MP4. Keep your source and any separate subtitle files so you can add the tracks back if needed.',
  },
  {
    q: 'Does this work with other languages, vertical clips, or moving words?',
    a: 'The detector can work with different scripts and portrait footage, and it examines changing text across frames. Results vary with motion, placement, contrast, and background detail, so check the output carefully.',
  },
  {
    q: 'Do I need an account, and what can I try for free?',
    a: 'Sign in with Google or email to remove subtitles from video; a new account receives 15 free credits. Processing uses credits based on duration, mode, and output resolution, and no software installation is required.',
  },
]

const SUBTITLES_DESCRIPTION = 'Remove subtitles from video when they are burned into the picture. AI rebuilds the background without blur or cropping. Free to try.'

export const BURNED_SUBTITLES_FAQ: { q: string; a: string }[] = [
  {
    q: 'Do burned-in and hardcoded mean the same thing?',
    a: 'In this context both describe words rendered into the video image. They are not a selectable text layer, even if another track is also present.',
  },
  {
    q: 'How can I tell whether the words are a separate stream?',
    a: 'Disable the text option in your player and inspect the available tracks or your editing timeline. If the same words remain in the picture, that version is embedded; a video can contain both types.',
  },
  {
    q: 'Will every trace of the text disappear?',
    a: 'Not always. Fine patterns, moving objects, and complex edges can leave artifacts because the hidden pixels must be estimated; preview the result before using it.',
  },
  {
    q: 'Will a separate track survive, and does processing affect quality?',
    a: 'The exported MP4 is not guaranteed to retain separate tracks, so keep the source and any text files. Re-encoding can change quality or frame rate even when you keep the original resolution.',
  },
  {
    q: 'Which formats can I use, and do I need an account?',
    a: 'The tool accepts MP4, MOV, M4V, WebM, MKV, AVI, FLV, WMV, and TS; the output is MP4. Sign in with Google or email to process a clip, and new accounts receive 15 free credits.',
  },
]

const BURNED_SUBTITLES_DESCRIPTION = 'Burned-in subtitles and hardcoded subtitles are pixels. AI rebuilds the background frame by frame without blur or cropping. Free to try.'

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
    a: 'No. Everything runs in your browser and on our servers, with nothing to download or install. Sign in with Google or an email account to process videos and access your history across devices. New accounts get 15 free credits.',
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
    a: 'Your upload is used for one thing only: producing your result. The original and processed video are kept for 30 days, and nothing is shared, published or used for training.',
  },
  {
    q: 'Will the video quality drop?',
    a: 'Only the area where subtitles were found gets repainted. You can keep the original resolution or choose an available lower resolution; the video is re-encoded.',
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
  title: 'Remove Text from Video — Free AI Subtitle & Caption Remover',
  description:
    'Remove text from video, including hardcoded subtitles and captions. AI rebuilds the background without cropping or adding a watermark.',
  image: SHARED_OG_IMAGE,
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
    image: SHARED_OG_IMAGE,
  },
  '/pricing': {
    title: `Pricing | ${SITE_NAME}`,
    description: 'Compare credit packages and monthly plans for removing subtitles from video.',
    image: SHARED_OG_IMAGE,
  },
  '/privacy': {
    title: `Privacy Policy | ${SITE_NAME}`,
    description: `How ${SITE_NAME} handles the videos you upload: what is stored, for how long, and what is never done with your files.`,
  },
  '/terms': {
    title: `Terms of Service | ${SITE_NAME}`,
    description: `The terms that apply when you use ${SITE_NAME} to remove text from your videos.`,
  },
  '/remove-captions-from-video': {
    title: 'Remove Captions From Video — Erase Burned-In Captions Online',
    description: CAPTIONS_DESCRIPTION,
    image: `${SITE_URL}/demo/auto-after.jpg`,
    schema: [
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: 'Video tools', item: `${SITE_URL}/#video-tools` },
          { '@type': 'ListItem', position: 3, name: 'Remove captions from video', item: absoluteUrl('/remove-captions-from-video') },
        ],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: CAPTIONS_FAQ.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ],
  },
  '/remove-subtitles-from-video': {
    title: 'Remove Subtitles From Video — Erase Hardcoded Subs Online',
    description: SUBTITLES_DESCRIPTION,
    image: `${SITE_URL}/demo/auto-after.jpg`,
    schema: [
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: 'Video tools', item: `${SITE_URL}/#video-tools` },
          { '@type': 'ListItem', position: 3, name: 'Remove subtitles from video', item: absoluteUrl('/remove-subtitles-from-video') },
        ],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: SUBTITLES_FAQ.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ],
  },
  '/remove-burned-in-subtitles': {
    title: 'Remove Burned-In Subtitles — Erase Hardcoded Subs Online',
    description: BURNED_SUBTITLES_DESCRIPTION,
    image: `${SITE_URL}/demo/auto-after.jpg`,
    schema: [
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: 'Video tools', item: `${SITE_URL}/#video-tools` },
          { '@type': 'ListItem', position: 3, name: 'Remove burned-in subtitles', item: absoluteUrl('/remove-burned-in-subtitles') },
        ],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: BURNED_SUBTITLES_FAQ.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ],
  },
}

export function metaFor(route: Route): PageMeta {
  return META[route] ?? HOME_META
}

/** 站点级结构化数据，每个页面都带上。 */
export function siteSchema(route: Route = '/'): Record<string, unknown>[] {
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
      url: route === '/remove-captions-from-video' || route === '/remove-subtitles-from-video' || route === '/remove-burned-in-subtitles' ? absoluteUrl(route) : SITE_URL,
      description: route === '/remove-captions-from-video' ? CAPTIONS_DESCRIPTION : route === '/remove-subtitles-from-video' ? SUBTITLES_DESCRIPTION : route === '/remove-burned-in-subtitles' ? BURNED_SUBTITLES_DESCRIPTION :
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
  const existingImage = document.head.querySelector('meta[property="og:image"]')
  if (meta.image) {
    const image = existingImage ?? document.createElement('meta')
    image.setAttribute('property', 'og:image')
    image.setAttribute('content', meta.image)
    if (!existingImage) document.head.appendChild(image)
  } else {
    existingImage?.remove()
  }
  document.head.querySelectorAll('script[type="application/ld+json"]').forEach((script) => script.remove())
  if (route !== '/') {
    for (const block of [...siteSchema(route), ...(meta.schema ?? [])]) {
      const script = document.createElement('script')
      script.type = 'application/ld+json'
      script.textContent = JSON.stringify(block)
      document.head.appendChild(script)
    }
  }
}

function setTag(selector: string, attribute: string, value: string): void {
  const element = document.head.querySelector(selector)
  if (element) element.setAttribute(attribute, value)
}
