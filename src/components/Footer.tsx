import { NavLink } from './Navbar'
import { LogoIcon } from './icons'
import { CONTACT_EMAIL, SITE_NAME, SITE_TAGLINE } from '../config'

export default function Footer({ onNavigate }: { onNavigate: (to: string) => void }) {
  return (
    <footer className="footer">
      <div className="footer__inner">
        <div className="footer__brand">
          <LogoIcon className="footer__logo" />
          <div>
            <p className="footer__name">{SITE_NAME}</p>
            <p className="footer__tagline">{SITE_TAGLINE}</p>
          </div>
        </div>
        <nav className="footer__links" aria-label="Footer">
          <NavLink href="/" onNavigate={onNavigate}>
            Remove text
          </NavLink>
          <NavLink href="/how-it-works" onNavigate={onNavigate}>
            How it works
          </NavLink>
          <NavLink href="/privacy" onNavigate={onNavigate}>
            Privacy
          </NavLink>
          <NavLink href="/terms" onNavigate={onNavigate}>
            Terms
          </NavLink>
          <a href={`mailto:${CONTACT_EMAIL}`}>Contact</a>
        </nav>
        <nav className="footer__links footer__tools" aria-label="Video Tools" id="video-tools">
          <span>Video Tools</span>
          <NavLink href="/remove-captions-from-video" onNavigate={onNavigate}>Remove captions from video</NavLink>
          <NavLink href="/" onNavigate={onNavigate}>Remove text from video</NavLink>
          <NavLink href="/remove-subtitles-from-video" onNavigate={onNavigate}>Remove subtitles from video</NavLink>
          <NavLink href="/remove-burned-in-subtitles" onNavigate={onNavigate}>Remove burned-in subtitles</NavLink>
        </nav>
        <a href="https://neeed.directory/products/removetextfromvideo?utm_source=removetextfromvideo" target="_blank" rel="noopener">
          <img src="https://neeed.directory/badges/neeed-badge-light.svg" alt="Featured on neeed.directory" width="139" />
        </a>
        <a href="https://www.aiwizard.ai/" target="_blank" rel="noopener" title="remove text from video on aiwizard">
          <img src="https://www.aiwizard.ai/badges/featured-on-aiwizard-dark.svg" alt="remove text from video featured on aiwizard, the AI tools directory" width="250" height="54" />
        </a>
      </div>
      <p className="footer__legal">
        © {new Date().getFullYear()} {SITE_NAME}. Only upload videos you own or have permission to edit.
      </p>
    </footer>
  )
}
