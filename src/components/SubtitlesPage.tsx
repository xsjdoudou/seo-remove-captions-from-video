import VideoStudio from './VideoStudio'
import { NavLink } from './Navbar'
import { SUBTITLES_FAQ } from '../seo'

export default function SubtitlesPage({ onNavigate }: { onNavigate: (to: string) => void }) {
  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <NavLink href="/" onNavigate={onNavigate}>Home</NavLink>
        <span aria-hidden="true">›</span>
        <a href="/#video-tools">Video tools</a>
        <span aria-hidden="true">›</span>
        <span aria-current="page">Remove subtitles from video</span>
      </nav>

      <VideoStudio>
        <section className="hero">
          <div className="hero__inner">
            <h1 className="hero__title">Remove subtitles from video</h1>
            <p className="hero__subtitle">
              Remove subtitles from video when the words are embedded in the image, with AI reconstruction
              of the picture behind them.
            </p>
          </div>
        </section>
      </VideoStudio>

      <section className="section section--alt">
        <h2 className="section__title">Which kind of subtitles do you have?</h2>
        <p className="section__lede">Check how the words are stored before deciding whether your file needs processing.</p>
        <div className="scope">
          <div className="scope__col scope__col--yes">
            <h3 className="scope__heading">Separate text or track</h3>
            <ul>
              <li>Soft subtitles can be an SRT or VTT file, or a selectable stream inside the container.</li>
              <li>Try the player&apos;s subtitle menu and turn the track off. In an editor, look for a separate item on the timeline.</li>
              <li>To make a copy without that stream, use a remuxing tool to exclude it. You do not need to upload the video or run AI.</li>
            </ul>
          </div>
          <div className="scope__col scope__col--no">
            <h3 className="scope__heading">Text baked into the picture</h3>
            <ul>
              <li>Hardcoded subtitles remain visible when every text stream is disabled.</li>
              <li>They are often found in screen recordings, social exports, and older finished edits.</li>
              <li>If the letters cannot be selected separately on the timeline, treat them as pixels that need reconstruction.</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">Why embedded words cannot be turned off</h2>
        <div className="caption-copy">
          <p>
            A rendered letter replaces part of the image in each frame where it appears. There is no hidden
            switch that restores the covered pixels, and the missing detail cannot be recovered exactly from
            a flattened export. The AI instead identifies the lettering across frames and estimates the
            underlying scene using nearby visual information.
          </p>
          <p>
            This approach aims to fill the affected area rather than conceal it with a blur or discard the
            bottom of the shot. Complicated textures, quick movement, and changing light can still produce
            imperfect results. For an overview of the same editing workspace, visit the <NavLink href="/" onNavigate={onNavigate}>video text tool</NavLink>.
          </p>
        </div>
      </section>

      <section className="section section--alt">
        <h2 className="section__title">Remove subtitles from video online free in three steps</h2>
        <ol className="steps">
          <li className="step">
            <span className="step__number">1</span>
            <h3 className="step__title">Select your source</h3>
            <p>Choose a supported clip from your device. Sign in, then pick automatic detection or draw a region; you can keep the source resolution or choose an available smaller size.</p>
          </li>
          <li className="step">
            <span className="step__number">2</span>
            <h3 className="step__title">Run the reconstruction</h3>
            <p>Submit the clip and let the service process the image over time. Duration, output size, and the chosen mode determine credit usage; longer or larger files can take more time.</p>
          </li>
          <li className="step">
            <span className="step__number">3</span>
            <h3 className="step__title">Check the finished MP4</h3>
            <p>Watch the result before downloading it without an added watermark. No installation is needed; because the output is re-encoded, quality or frame rate may differ.</p>
          </li>
        </ol>
      </section>

      <section className="section">
        <h2 className="section__title">What the model is designed to find</h2>
        <p className="section__lede">Subtitle-like lettering is the target; placement and visual complexity affect the outcome.</p>
        <div className="scope">
          <div className="scope__col scope__col--yes">
            <h3 className="scope__heading">Handled well</h3>
            <ul>
              <li>Dialogue text positioned near the bottom or center of a shot</li>
              <li>Burned-in subtitles that change with the speaker or translation</li>
              <li>Embedded text in a range of writing systems</li>
              <li>Portrait and landscape footage with readable subtitle-style lines</li>
            </ul>
          </div>
          <div className="scope__col scope__col--no">
            <h3 className="scope__heading">Usually left alone</h3>
            <ul>
              <li>Corner watermarks, channel logos, and platform badges</li>
              <li>Scrolling banners fixed to the top of the frame</li>
              <li>Scene text on signs, screens, and packaging</li>
              <li>A separate subtitle track, which does not require this tool</li>
            </ul>
            <p className="scope__note">
              Detection is not a guarantee: unusual positions may be missed, and nearby details may be affected.
              Inspect the processed area and keep your original file until you are satisfied.
            </p>
          </div>
        </div>
      </section>

      <section className="section section--alt">
        <h2 className="section__title">Subtitles and captions: where they overlap</h2>
        <div className="caption-copy">
          <p>
            Both can represent spoken words on screen. In common usage, subtitles often translate dialogue,
            while captions can also identify speakers and describe audible events; either may be supplied
            separately or rendered into the picture. Read the <NavLink href="/remove-captions-from-video" onNavigate={onNavigate}>guide to caption removal</NavLink> for
            examples involving styled labels and social clips.
          </p>
          <p>
            If your export contains other subtitle-style lettering, the <NavLink href="/" onNavigate={onNavigate}>main editing workspace</NavLink> offers
            the same automatic and region-selection modes. Always choose the approach that matches the
            source: a selectable stream can be switched off without modifying the visual frames.
          </p>
        </div>
      </section>

      <section className="section" id="faq">
        <h2 className="section__title">Questions about subtitle removal</h2>
        <div className="faq">
          {SUBTITLES_FAQ.map((item) => (
            <details className="faq__item" key={item.q}>
              <summary className="faq__question">{item.q}</summary>
              <p className="faq__answer">{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="cta">
        <h2 className="cta__title">Have a clip ready to edit?</h2>
        <p className="cta__text">Select your file and review the processed video in your browser.</p>
        <a className="btn btn--primary btn--lg" href="#tool">Choose your video</a>
      </section>
    </>
  )
}
