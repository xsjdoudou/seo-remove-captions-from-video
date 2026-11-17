import VideoStudio from './VideoStudio'
import { NavLink } from './Navbar'
import { CAPTIONS_FAQ } from '../seo'

export default function CaptionsPage({ onNavigate }: { onNavigate: (to: string) => void }) {
  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <NavLink href="/" onNavigate={onNavigate}>Home</NavLink>
        <span aria-hidden="true">›</span>
        <a href="/#video-tools">Video tools</a>
        <span aria-hidden="true">›</span>
        <span aria-current="page">Remove captions from video</span>
      </nav>

      <VideoStudio>
        <section className="hero">
          <div className="hero__inner">
            <h1 className="hero__title">Remove captions from video</h1>
            <p className="hero__subtitle">
              Remove captions from video when the words are baked into the picture, and let AI reconstruct
              the area behind the lettering.
            </p>
          </div>
        </section>
      </VideoStudio>

      <section className="section section--alt">
        <h2 className="section__title">What counts as a caption?</h2>
        <div className="caption-copy">
          <p>
            Captions make spoken content accessible by showing dialogue and often identifying speakers, music,
            or other meaningful sounds. Subtitles commonly translate or transcribe speech; in everyday use the
            terms overlap. A caption can be plain text, a colorful label, or a sequence of styled words timed
            to a voice.
          </p>
          <p>
            Closed captions are a separate, selectable track that a player can show or hide. Open captions are
            visible in the picture itself. Once exported as burned-in captions, their letters are part of each
            affected frame rather than an editable layer. Check the player settings first: turning off a separate
            track is simpler than processing the picture.
          </p>
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">Why visible captions cannot simply be switched off</h2>
        <div className="caption-copy">
          <p>
            When text has been flattened into a video, the pixels under the letters are no longer available as
            a separate layer. To remove captions from video, the tool detects the text frame by frame and uses
            information from the surrounding picture to reconstruct the obscured area. It does not merely place
            a blur over the words or crop away the bottom of the image.
          </p>
          <p>
            Reconstruction is an estimate, not a recovery of the original pixels. Moving faces, detailed
            patterns, and rapid cuts can leave visible artifacts. For footage with other kinds of subtitle-style
            lettering, explore the <NavLink href="/" onNavigate={onNavigate}>video text removal tool</NavLink>.
          </p>
        </div>
      </section>

      <section className="section section--alt">
        <h2 className="section__title">From upload to download in three steps</h2>
        <ol className="steps">
          <li className="step">
            <span className="step__number">1</span>
            <h3 className="step__title">Choose a clip</h3>
            <p>Select a supported video from your device. Pick automatic detection or draw a region around the text, and choose the original resolution or an available smaller output.</p>
          </li>
          <li className="step">
            <span className="step__number">2</span>
            <h3 className="step__title">Process the frames</h3>
            <p>The AI locates the targeted lettering and fills the affected pixels using visual context. Processing time varies with the length and resolution of the clip.</p>
          </li>
          <li className="step">
            <span className="step__number">3</span>
            <h3 className="step__title">Inspect and download</h3>
            <p>Play the result in your browser, then download the MP4 without an added watermark. The video is re-encoded, so frame rate and quality may change.</p>
          </li>
        </ol>
      </section>

      <section className="section">
        <h2 className="section__title">Where the detector works best</h2>
        <p className="section__lede">The model focuses on subtitle-style text, so placement and the background matter.</p>
        <div className="scope">
          <div className="scope__col scope__col--yes">
            <h3 className="scope__heading">Handled well</h3>
            <ul>
              <li>Dialogue lines across the lower or central picture</li>
              <li>Speaker labels and sound descriptions near dialogue</li>
              <li>Changing lines and styled words in the caption band</li>
              <li>Embedded translations in different writing systems</li>
            </ul>
          </div>
          <div className="scope__col scope__col--no">
            <h3 className="scope__heading">Usually left alone</h3>
            <ul>
              <li>Corner watermarks, channel logos, and platform badges</li>
              <li>Scrolling banners at the top edge of the picture</li>
              <li>Text belonging to the scene, such as signs, screens, and packaging</li>
              <li>Full-screen titles and end credits</li>
            </ul>
            <p className="scope__note">
              Automatic detection may miss difficult lettering or occasionally affect nearby text. Review the
              result, especially when important details lie close to the area being edited.
            </p>
          </div>
        </div>
      </section>

      <section className="section section--alt">
        <h2 className="section__title">Choosing between caption and subtitle removal</h2>
        <div className="caption-copy">
          <p>
            For a selectable subtitle track, try disabling it in your player or removing that track in an editor
            first. For subtitle-focused guidance, see <a href="/remove-subtitles-from-video">remove subtitles from
            video</a>. If the words are already part of the picture, the <NavLink href="/" onNavigate={onNavigate}>main
            text removal workspace</NavLink> handles the same kind of embedded lettering. You can also remove
            captions online here without installing a desktop editor.
          </p>
        </div>
      </section>

      <section className="section" id="faq">
        <h2 className="section__title">Questions about caption removal</h2>
        <div className="faq">
          {CAPTIONS_FAQ.map((item) => (
            <details className="faq__item" key={item.q}>
              <summary className="faq__question">{item.q}</summary>
              <p className="faq__answer">{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="cta">
        <h2 className="cta__title">Ready to work on your clip?</h2>
        <p className="cta__text">Choose a video and review the result before downloading.</p>
        <a className="btn btn--primary btn--lg" href="#tool">Start with your video</a>
      </section>
    </>
  )
}
