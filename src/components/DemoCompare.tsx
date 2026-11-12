import { useEffect, useRef, useState } from 'react'
import type { EraseMode } from '../lib/api'

type Case = {
  mode: EraseMode
  label: string
  /** 这个例子想说明的那一件事。两个例子摆在一起的意义全在这句话上。 */
  lede: string
  beforeCaption: string
  afterCaption: string
  slug: string
}

const CASES: Case[] = [
  {
    mode: 'auto',
    label: 'Auto',
    lede: 'A caption burned in along the bottom. Nothing was selected — the subtitles were found and erased on their own.',
    beforeCaption: 'The caption is baked into the picture.',
    afterCaption: 'Gone — and the background behind it is back.',
    slug: 'auto',
  },
  {
    mode: 'box',
    label: 'Box select',
    lede: 'Four pieces of text on screen, one box drawn over the subtitle. Only what was inside the box is erased.',
    beforeCaption: 'Subtitle, show title, logo, mic flag.',
    afterCaption: 'Subtitle gone. The other three are untouched.',
    slug: 'box',
  },
]

/**
 * 首页上的"处理前/处理后"样例。
 *
 * 两个模式各一个例子,左右并排全摆出来,不做成要点一下才切换的标签页。
 *
 * 进到这个站的人心里的问题只有一个——"去得干不干净"。答案摆在那儿比
 * 藏在交互后面值钱:标签页里没被选中的那一半等于不存在,绝大多数人
 * 不会去点第二个标签,于是"框选"这个模式对他们来说从未出现过。
 *
 * 并排还让两个模式之间的区别自己说话:左边什么都没选,整条字幕没了;
 * 右边画了一个框,屏幕上另外三处文字原封不动。这个对比是跨着两组看出来的,
 * 一次只显示一组的时候,用户得靠记忆去比,而他不会。
 */
export default function DemoCompare() {
  return (
    <div className="demo">
      {CASES.map((item) => (
        <DemoCase key={item.slug} item={item} />
      ))}
    </div>
  )
}

/**
 * 一个模式的一组对照。
 *
 * 每组自己管自己的可见性和播放——两组各有一个 IntersectionObserver,
 * 而不是父组件统一调度:窄屏上两组是上下排的,下面那组在视野外时
 * 不该跟着上面一起把一兆的片子拉下来。
 */
function DemoCase({ item }: { item: Case }) {
  const [visible, setVisible] = useState(false)
  const [still, setStill] = useState(false)

  const wrapRef = useRef<HTMLDivElement>(null)
  const beforeRef = useRef<HTMLVideoElement>(null)
  const afterRef = useRef<HTMLVideoElement>(null)

  /*
   * 滚到跟前才开始加载和播放。
   *
   * 每条片子都有一兆上下,四条摆在首屏下面第二屏的位置,一进页面就预载
   * 等于拿首屏的带宽去换用户可能根本没滚到的东西。
   * preload="none" + 下面那个 play() 把这笔开销推迟到它真的进入视野那一刻。
   */
  useEffect(() => {
    const node = wrapRef.current
    if (!node) return

    // 系统里关掉动效的人,不该被几条自动播的循环视频迎面糊一脸。
    // 给他们留着封面和控件,要看自己点。
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setStill(true)
      return
    }

    const observer = new IntersectionObserver((entries) => setVisible(entries[0]?.isIntersecting ?? false), {
      threshold: 0.25,
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const videos = [beforeRef.current, afterRef.current].filter((v): v is HTMLVideoElement => !!v)
    if (still || videos.length === 0) return
    if (!visible) {
      videos.forEach((video) => video.pause())
      return
    }
    // 自动播放被浏览器策略挡下来是正常情况(静音循环一般不会),
    // 挡下来就停在封面上,不该把异常抛到控制台里。
    videos.forEach((video) => void video.play().catch(() => {}))
  }, [visible, still])

  /*
   * 两个 <video> 各解各的码,跑久了会错开几帧——而这个样例的全部意义
   * 就在于两边是同一帧的对照,错开了说服力就没了。
   * 差过 0.12 秒(约 3 帧)就把右边拉回左边的进度。
   */
  useEffect(() => {
    const before = beforeRef.current
    const after = afterRef.current
    if (!before || !after) return

    const resync = () => {
      if (before.readyState < 2 || after.readyState < 2) return
      if (Math.abs(after.currentTime - before.currentTime) > 0.12) {
        after.currentTime = before.currentTime
      }
    }

    before.addEventListener('timeupdate', resync)
    return () => before.removeEventListener('timeupdate', resync)
  }, [])

  // 框选那组的"处理前"用的是带框的那版素材:要让人看见框画在哪儿,
  // 才解释得了为什么只有框里那行不见了。
  const beforeSlug = `${item.slug}-before${item.mode === 'box' ? '-transparent' : ''}`

  return (
    <section className="demo__case" ref={wrapRef} aria-label={`${item.label} example`}>
      {/* 标题用的词和左边那列的模式选择一字不差:用户在这里看到的
          "Box select",待会儿要在工具里自己点的也是同一个词。 */}
      <h3 className="demo__caseTitle">{item.label}</h3>
      <p className="demo__lede">{item.lede}</p>

      <div className="demo__pair">
        <figure className="demo__item">
          <div className="demo__frame">
            <video
              ref={beforeRef}
              className="demo__video"
              src={`/demo/${beforeSlug}.mp4`}
              poster={`/demo/${beforeSlug}.jpg`}
              muted
              loop
              playsInline
              preload="none"
              controls={still}
              aria-label={`Original clip — ${item.label} example`}
            />
            <span className="demo__tag">Before</span>
          </div>
          <figcaption className="demo__caption">{item.beforeCaption}</figcaption>
        </figure>

        <figure className="demo__item demo__item--after">
          <div className="demo__frame">
            <video
              ref={afterRef}
              className="demo__video"
              src={`/demo/${item.slug}-after.mp4`}
              poster={`/demo/${item.slug}-after.jpg`}
              muted
              loop
              playsInline
              preload="none"
              controls={still}
              aria-label={`The same clip after processing — ${item.label} example`}
            />
            <span className="demo__tag">After</span>
          </div>
          <figcaption className="demo__caption">{item.afterCaption}</figcaption>
        </figure>
      </div>
    </section>
  )
}
