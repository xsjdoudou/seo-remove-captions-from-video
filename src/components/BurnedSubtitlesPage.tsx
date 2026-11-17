import VideoStudio from './VideoStudio'
import { NavLink } from './Navbar'
import { BURNED_SUBTITLES_FAQ } from '../seo'

export default function BurnedSubtitlesPage({ onNavigate }: { onNavigate: (to: string) => void }) {
  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <NavLink href="/" onNavigate={onNavigate}>Home</NavLink>
        <span aria-hidden="true">›</span>
        <a href="/#video-tools">Video tools</a>
        <span aria-hidden="true">›</span>
        <span aria-current="page">Remove burned-in subtitles</span>
      </nav>

      <VideoStudio>
        <section className="hero">
          <div className="hero__inner">
            <h1 className="hero__title">Remove burned-in subtitles</h1>
            <p className="hero__subtitle">Erase dialogue already rendered into your footage and reconstruct the picture behind the words with AI.</p>
          </div>
        </section>
      </VideoStudio>

      <section className="section section--alt">
        <h2 className="section__title">What does “burned-in” mean?</h2>
        <div className="caption-copy">
          <p>
            Burned-in subtitles are letters rendered into the image itself. People also call them hardcoded
            subtitles, baked-in text, or embedded subtitles, although “embedded” can sometimes refer to a
            separate stream inside a container. In the first sense, the words occupy picture pixels and
            cannot be disabled with a player setting.
          </p>
          <p>
            Start by turning text display off in your player. Next, inspect the editing timeline for a
            separately selectable layer. Finally, check for an extractable .srt or .vtt file or stream.
            If the words stay visible after every text layer is disabled, the visible version is part of
            the picture. A clip may contain both rendered words and a separate file, so finding one does
            not prove that the picture is clean.
          </p>
          <p>
            If a selectable layer is the only source, hide it or exclude that stream while remuxing.
            Keep the original file and any sidecar text.
          </p>
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">Compare three ways words reach the screen</h2>
        <div className="cards">
          <article className="card">
            <h3 className="card__title">Words rendered into video</h3>
            <p className="card__text">Burned in subtitles and hardcoded subtitles describe this fixed picture layer. A player cannot hide those pixels; changing them requires a visual edit such as AI reconstruction.</p>
          </article>
          <article className="card">
            <h3 className="card__title">Selectable text</h3>
            <p className="card__text">Soft subtitles are stored separately, either as a file or as a subtitle track inside the container. Turn them off or remove the stream without altering image frames.</p>
          </article>
          <article className="card">
            <h3 className="card__title">Always-visible access text</h3>
            <p className="card__text">Open captions may include speaker names and sound descriptions rendered into the picture. They also cannot be toggled off and can be candidates for the same visual process.</p>
          </article>
        </div>
      </section>

      <section className="section section--alt">
        <h2 className="section__title">Why hardcoded words cannot be switched off</h2>
        <div className="caption-copy">
          <p>
            A finished export no longer stores the original background underneath each glyph as a separate
            layer. The processing model identifies the targeted text over successive frames and estimates
            what belongs there from surrounding visual information. It is an approximation, not a guarantee
            that lost detail can be recovered exactly.
          </p>
          <p>
            Cropping would discard part of every frame, while masking or blurring would hide the same
            portion behind a patch. Reconstruction aims to preserve the full composition instead. Busy
            patterns, camera movement, and faces passing behind letters can still make the outcome less
            convincing; check the preview before using the result in a final edit.
          </p>
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">Remove burned in subtitles in three steps</h2>
        <ol className="steps">
          <li className="step">
            <span className="step__number">1</span>
            <h3 className="step__title">Pick a source file</h3>
            <p>Choose a supported clip and sign in. Use automatic detection or mark a region yourself, then choose the original size or an available smaller output.</p>
          </li>
          <li className="step">
            <span className="step__number">2</span>
            <h3 className="step__title">Process the picture</h3>
            <p>Submit the selection for frame-by-frame analysis and background reconstruction. Time and credit usage depend on the clip length, selected mode, and output resolution.</p>
          </li>
          <li className="step">
            <span className="step__number">3</span>
            <h3 className="step__title">Review the export</h3>
            <p>Watch the processed clip and download an MP4 without an added watermark. No installation is needed; the video is re-encoded, so quality or frame rate can change.</p>
          </li>
        </ol>
      </section>

      <section className="section section--alt">
        <h2 className="section__title">What to expect from detection</h2>
        <p className="section__lede">The model is designed around subtitle-style lettering, not every object in a scene.</p>
        <div className="scope">
          <div className="scope__col scope__col--yes">
            <h3 className="scope__heading">Handled well</h3>
            <ul>
              <li>Dialogue lines in the lower or central portion of a frame</li>
              <li>Translated text rendered over the original footage</li>
              <li>Lines that change as speakers continue a conversation</li>
              <li>Subtitle-style writing in multiple scripts and orientations</li>
            </ul>
          </div>
          <div className="scope__col scope__col--no">
            <h3 className="scope__heading">Usually left alone</h3>
            <ul>
              <li>Corner watermarks, channel logos, and platform badges</li>
              <li>Scrolling banners along the top of the frame</li>
              <li>Scene text on signs, screens, or packaging</li>
              <li>Separate text streams, which do not need image reconstruction</li>
            </ul>
            <p className="scope__note">Out-of-area elements are not the intended target. Automatic detection can still miss words or affect nearby details, so review each result.</p>
          </div>
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">Which page fits your file?</h2>
        <div className="caption-copy">
          <p>
            For a selectable stream or an extractable text file, read the <NavLink href="/remove-subtitles-from-video" onNavigate={onNavigate}>subtitle format guide</NavLink> before
            uploading. For on-screen speaker labels or sound descriptions, see the <NavLink href="/remove-captions-from-video" onNavigate={onNavigate}>caption editing guide</NavLink>.
            If you have another overlay resembling dialogue, the <NavLink href="/" onNavigate={onNavigate}>main video text workspace</NavLink> provides
            the same modes.
          </p>
          <p>
            Use the <NavLink href="/" onNavigate={onNavigate}>main text tool</NavLink> for a clip with hardcoded subs.
            Save an untouched copy and compare the preview.
          </p>
        </div>
      </section>

      <section className="section section--alt" id="faq">
        <h2 className="section__title">Questions before you process</h2>
        <div className="faq">
          {BURNED_SUBTITLES_FAQ.map((item) => (
            <details className="faq__item" key={item.q}>
              <summary className="faq__question">{item.q}</summary>
              <p className="faq__answer">{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="cta">
        <h2 className="cta__title">Ready to inspect your footage?</h2>
        <p className="cta__text">Choose the source, process it, and check the result before downloading.</p>
        <a className="btn btn--primary btn--lg" href="#tool">Choose a clip</a>
      </section>
    </>
  )
}
