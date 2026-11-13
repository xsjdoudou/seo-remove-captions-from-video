import { useState } from 'react'
import Workspace from './Workspace'
import HistoryList from './HistoryList'
import ModePicker from './ModePicker'
import DemoCompare from './DemoCompare'
import { NavLink } from './Navbar'
import { FAQ, siteSchema, metaFor } from '../seo'
import type { EraseMode } from '../lib/api'
import { ClockIcon, GlobeIcon, LayersIcon, ShieldIcon, SparkIcon } from './icons'
import Billing from './Billing'
import { useEffect } from 'react'
import { fetchServiceConfig } from '../lib/api'

/**
 * 首页。
 *
 * 结构是刻意的：工具放在第一屏,下面才是正文。
 * 搜索引擎要看到足够的、真实回答问题的文字才会给排名,而来访的人想要的是
 * 立刻能用的东西——所以两者都给,顺序上让人优先。
 */
export default function HomePage({ onNavigate }: { onNavigate: (to: string) => void }) {
  /*
   * 侧栏收起与否。
   *
   * 状态放在这里而不是 HistoryList 里：HomePage 是 .studio 这个网格的拥有者，
   * 开合要落在它的一个子节点上。网格本身不跟着变——左右两列永远各占
   * --side-w，中间那列因此是视口的正中，开合历史只是在右列里显示或隐藏那张
   * 卡片，hero 和画布一个像素都不动。
   *
   * 默认展开：既然收起也省不出地方给画布（列宽是固定的），那块位置空着不如
   * 把面板摆在那儿——回头客一进来就看见上次的成片还在，不用先发现那条
   * 把手、再想到可以点它。第一次来的人看到的是一块写着"还没有视频"的空面板，
   * 这本身也说清楚了这里会留东西。嫌占地方点一下就收。
   *
   * 不记进 localStorage：预渲染出来的 HTML 是展开的，从存储里读状态会让
   * 页面在 hydrate 之后当着用户的面跳一下。
   */
  const [historyOpen, setHistoryOpen] = useState(true)

  /*
   * 去字幕的方式。
   *
   * 状态在这里是因为它横跨两个组件：左边那列负责选，中间的画布负责用。
   * 放进 Workspace 的话,选择器就只能长在画布上方,而画布上方正是
   * 第一屏最金贵的那几十像素。
   */
  const [mode, setMode] = useState<EraseMode>('auto')
  /** 有任务在跑时不让切模式：切了也改不了已经提交出去的那个任务。 */
  const [busy, setBusy] = useState(false)
  const [billingEnabled, setBillingEnabled] = useState(false)
  useEffect(() => {
    void fetchServiceConfig().then((config) => setBillingEnabled(Boolean(config.billingEnabled))).catch(() => {})
  }, [])

  return (
    <>
      {/* 预渲染时这段 JSON-LD 会进静态 HTML,爬虫不执行 JS 也能读到。 */}
      <StructuredData />

      {/*
        hero 和工具在同一个 grid 里：历史面板要从导航栏底下一路铺到工具区底部，
        跨两行只有它俩在同一个容器里才做得到。
        hero 因此也落在中间那列——它和画布共用同一条中轴，标题不会比画布宽出去。
      */}
      <div className="studio">
        <section className="hero">
          <div className="hero__inner">
            <h1 className="hero__title">Remove hardcoded subtitles from video</h1>
            <p className="hero__subtitle">
              The AI rebuilds the background behind the lettering — no blur box, no cropped frame.
            </p>
            <ul className="hero__badges">
              <li>{billingEnabled ? '15 free credits' : 'No signup'}</li>
              <li>No watermark</li>
              <li>Deleted in 24 h</li>
            </ul>
          </div>
        </section>

        <ModePicker mode={mode} onChange={setMode} disabled={busy} />
        <Workspace mode={mode} onBusyChange={setBusy} />
        <HistoryList open={historyOpen} onToggle={() => setHistoryOpen((value) => !value)} />
      </div>
      {billingEnabled && <Billing />}

      {/*
        样例紧挨着工具放：从拖放框往下滚一眼就看到"去完长这样"。
        放到页面更下面去的话，它就只有已经被文案说服的人才看得见，
        而它本来是用来说服人的那一个东西。

        用 --alt 底色是为了保住各节深浅相间的节奏：它插在工具区和 features
        中间，自己要是也用普通底色，下面一长串就全跟着错位了。
      */}
      <section className="section section--alt" id="example">
        <h2 className="section__title">See it on a real clip</h2>
        <p className="section__lede">
          Five seconds of a vertical video, before and after — one clip per mode. Nothing is cropped, nothing is
          blurred: the background behind the lettering is rebuilt.
        </p>
        <DemoCompare />
      </section>

      <section className="section" id="features">
        <h2 className="section__title">Why the result looks clean</h2>
        <p className="section__lede">
          Most subtitle removers crop the frame or paste a blur box over the words. Both leave a scar.
        </p>
        <div className="cards">
          <Card icon={<LayersIcon className="card__icon" />} title="Repainted, not covered">
            The background behind the lettering is reconstructed from the surrounding frames.
          </Card>
          <Card icon={<SparkIcon className="card__icon" />} title="Tracks changing subtitles">
            Detection runs per frame, so captions that move or change line are followed, not smeared.
          </Card>
          <Card icon={<GlobeIcon className="card__icon" />} title="Any language">
            Latin, Chinese, Japanese, Korean, Arabic, Cyrillic and Thai — all just pixels to remove.
          </Card>
          <Card icon={<ClockIcon className="card__icon" />} title="Full quality kept">
            Same resolution and frame rate. Everything outside the subtitle area is untouched.
          </Card>
          <Card icon={<ShieldIcon className="card__icon" />} title="Your file stays yours">
            Deleted within 24 hours. Never published, never used for training.
          </Card>
          <Card icon={<LayersIcon className="card__icon" />} title="Nothing to install">
            Runs in the browser. No editor or plugin needed.
          </Card>
        </div>
      </section>

      <section className="section section--alt" id="how">
        <h2 className="section__title">Three steps</h2>
        <ol className="steps">
          <li className="step">
            <span className="step__number">1</span>
            <h3 className="step__title">Upload your video</h3>
            <p>
              Drag a file in or pick one from your device. MP4, MOV, WebM, MKV, AVI and more are accepted — the result
              always comes back as MP4.
            </p>
          </li>
          <li className="step">
            <span className="step__number">2</span>
            <h3 className="step__title">The AI erases the subtitles</h3>
            <p>
              Every frame is scanned for caption text. The detected region is masked and then filled in using what the
              surrounding frames reveal about the background behind it.
            </p>
          </li>
          <li className="step">
            <span className="step__number">3</span>
            <h3 className="step__title">Preview and download</h3>
            <p>
              Watch the result in your browser before you commit to it. If it looks right, download the MP4 — clean,
              and with no watermark added.
            </p>
          </li>
        </ol>
        <p className="section__more">
          <NavLink href="/how-it-works" onNavigate={onNavigate}>
            Read the longer explanation of how inpainting works →
          </NavLink>
        </p>
      </section>

      {/*
        这一节是刻意放的:明确说清楚什么能去、什么去不掉。
        搜索这类工具的人最想知道的就是"我这个片子行不行",提前讲明白能挡掉
        一批注定失望的上传,也省掉一批退款和差评。SEO 上它接的是
        "will it remove my watermark" 这类带疑问的长尾词。
      */}
      <section className="section" id="scope">
        <h2 className="section__title">What it does and does not handle</h2>
        <p className="section__lede">
          Worth knowing before you upload. The model is trained on subtitles, and that shapes what it finds.
        </p>
        <div className="scope">
          <div className="scope__col scope__col--yes">
            <h3 className="scope__heading">Handled well</h3>
            <ul>
              <li>Hardcoded subtitles and open captions</li>
              <li>Burned-in translations and dual-language subtitle bands</li>
              <li>Lower-third captions and speaker labels</li>
              <li>Subtitles in any script, including CJK and Arabic</li>
              <li>Captions that change line or move between shots</li>
            </ul>
          </div>
          <div className="scope__col scope__col--no">
            <h3 className="scope__heading">Usually left alone</h3>
            <ul>
              <li>Corner watermarks, channel bugs and platform logos</li>
              <li>Scrolling banners pinned to the very top of the frame</li>
              <li>Text that is part of the scene — signs, screens, packaging</li>
              <li>Full-screen title cards and end credits</li>
            </ul>
            <p className="scope__note">
              The detector targets the caption band across the lower and central part of the frame. Anything outside it
              is usually treated as part of the picture — which is normally what you want.
            </p>
          </div>
        </div>
      </section>

      <section className="section section--alt" id="use-cases">
        <h2 className="section__title">What people use it for</h2>
        <div className="usecases">
          <UseCase title="Reusing footage across languages">
            A clip subtitled in one language is unusable in another market. Strip the burned-in subtitles and you have a
            clean master to re-subtitle however you like.
          </UseCase>
          <UseCase title="Repurposing social clips">
            Short-form videos arrive covered in auto-captions. Removing them gives you a neutral cut that fits a
            different platform, a different edit, or a different voiceover.
          </UseCase>
          <UseCase title="Cleaning up screen recordings">
            Auto-generated captions baked into a recording can be taken out without re-recording the whole session.
          </UseCase>
          <UseCase title="Fixing an old export">
            When the project file is long gone and only the rendered video is left, erasing the burned-in subtitle is
            the only way to change it.
          </UseCase>
          <UseCase title="Re-timing bad subtitles">
            Subtitles that drift out of sync cannot be nudged once they are baked in. Remove them, then add a proper
            subtitle track that you can actually edit.
          </UseCase>
          <UseCase title="Preparing archive material">
            Removing names and on-screen identifiers that sit in the caption area before footage gets filed or shared
            more widely.
          </UseCase>
        </div>
      </section>

      <section className="section" id="faq">
        <h2 className="section__title">Frequently asked questions</h2>
        <div className="faq">
          {FAQ.map((item) => (
            <details className="faq__item" key={item.q}>
              <summary className="faq__question">{item.q}</summary>
              <p className="faq__answer">{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="cta">
        <h2 className="cta__title">Ready to clean up your footage?</h2>
        <p className="cta__text">Upload a clip and see the result before you commit to anything.</p>
        <a className="btn btn--primary btn--lg" href="#tool">
          Remove subtitles from a video
        </a>
      </section>
    </>
  )
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <article className="card">
      {icon}
      <h3 className="card__title">{title}</h3>
      <p className="card__text">{children}</p>
    </article>
  )
}

function UseCase({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="usecase">
      <h3 className="usecase__title">{title}</h3>
      <p className="usecase__text">{children}</p>
    </article>
  )
}

function StructuredData() {
  const blocks = [...siteSchema(), ...(metaFor('/').schema ?? [])]
  return (
    <>
      {blocks.map((block, index) => (
        <script
          // 这里的内容全部来自 src/seo.ts 里的常量,没有任何用户输入,
          // 所以 dangerouslySetInnerHTML 在这里是安全的——也是往页面里写
          // JSON-LD 的唯一办法(React 会把普通字符串子节点转义掉)。
          key={index}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(block) }}
        />
      ))}
    </>
  )
}
