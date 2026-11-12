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
      </div>
      <p className="footer__legal">
        © {new Date().getFullYear()} {SITE_NAME}. Only upload videos you own or have permission to edit.
      </p>
    </footer>
  )
}
