import { CONTACT_EMAIL, SITE_NAME } from '../config'

/**
 * 隐私政策与服务条款。
 *
 * 写的是这套代码实际在做的事——24 小时清理、不做训练、源文件在成片下载完
 * 就删掉——而不是抄一份通用模板。模板里那些对不上的条款,既帮不了用户,
 * 真出事时也帮不了你。改了保留策略记得回来改这一页。
 */

const UPDATED = 'November 2025'
const TERMS_UPDATED = 'November 13, 2026'

export function PrivacyPage() {
  return (
    <article className="article">
      <h1 className="article__title">Privacy Policy</h1>
      <p className="article__meta">Last updated: {UPDATED}</p>

      <p className="article__lede">
        The short version: your video is used for one thing — producing your result — and then it is deleted. You can
        use the tool without an account; creating one is optional.
      </p>

      <h2>What we handle</h2>
      <ul className="article__list">
        <li>
          <strong>The video you upload.</strong> Stored on our server only for as long as it takes to process it.
        </li>
        <li>
          <strong>The processed result.</strong> Stored so you can preview and download it.
        </li>
        <li>
          <strong>Basic request data.</strong> Your IP address and the time of the request, kept alongside the job so we
          can apply fair-use limits and investigate abuse.
        </li>
        <li>
          <strong>Your Google profile, only if you sign in.</strong> Name, email address and profile picture, as
          supplied by Google.
        </li>
        <li>
          <strong>Your email account, if you create one.</strong> We store your email address and a salted password
          hash, not your password in plain text.
        </li>
      </ul>
      <p>
        Signing in is optional. Without it we never learn your name, email address or payment details — the tool works
        exactly the same, and the only thing you give up is seeing your history on another device.
      </p>

      <h2>Signing in with Google</h2>
      <p>
        If you choose to sign in, your browser loads Google&rsquo;s sign-in script at that moment — not before — and
        Google tells us your account identifier, name, email address and profile picture. We never see your Google
        password, and we ask for no other access to your Google account.
      </p>
      <p>
        You can also create an email and password account. Email accounts and Google accounts are separate, even if
        they use the same email address.
      </p>
      <p>
        We then set one cookie, so you stay signed in for up to 30 days. It holds a signed reference to your account and
        nothing else: no tracking identifier, no analytics, no advertising. Signing out deletes it.
      </p>
      <p>
        Want your account removed? Write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and we will delete
        your profile and every job record attached to it.
      </p>

      <h2>The &ldquo;your videos&rdquo; list</h2>
      <p>
        <strong>If you are not signed in,</strong> the list lives in your own browser, using local storage on your
        device. It never reaches our servers, and we cannot see it. That is also why it does not follow you to another
        browser or another device. Clearing it with the <em>Clear</em> button, or clearing your browser data, removes it
        completely.
      </p>
      <p>
        <strong>If you are signed in,</strong> the list is stored on our server against your account, which is what lets
        it follow you between devices. It holds job references, file names, sizes and outcomes — not the videos, which
        are deleted on the schedule below. We keep these records for 30 days. Removing an entry deletes it from our
        server immediately. When you sign in, any jobs you started anonymously on that browser are attached to your
        account so they are not lost.
      </p>

      <h2>How long files are kept</h2>
      <p>
        Your original upload is deleted as soon as the processed video has been retrieved — typically within minutes of
        the job finishing. Both the original and the result are deleted automatically no more than 24 hours after
        upload, whether or not you downloaded anything, and whether or not you have an account. Deletion is permanent;
        we keep no backup copies of user videos.
      </p>
      <p>You can also delete a job yourself at any time by starting a new one or closing out of the result.</p>

      <h2>Processing</h2>
      <p>
        Text removal is performed by a third-party cloud video-processing API. To do its work, that provider fetches
        your video from our server and returns the processed version. Your video is therefore handled by that provider
        for the duration of the job, under their own terms, and is not retained by us beyond the window described above.
      </p>

      <h2>What we never do</h2>
      <ul className="article__list">
        <li>We do not publish, share or sell your videos.</li>
        <li>We do not use your videos to train models.</li>
        <li>We do not watch or review your content except where we are legally required to.</li>
        <li>We do not run advertising or third-party tracking scripts on this site.</li>
        <li>
          We set no cookie at all unless you sign in, and the one we then set exists only to keep you signed in. We do
          not use cookies to track you across sites.
        </li>
      </ul>

      <h2>Your choices</h2>
      <p>
        You can use the whole tool without signing in, in which case we hold no personal identifier beyond a short-lived
        IP record and there is usually nothing left to delete by the time you would ask. If you do have an account, or
        you believe we hold something of yours and you want it removed, write to{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and we will deal with it.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes in a way that affects how your files are handled, the updated date above will change.
        Material changes will not be applied retroactively to files already processed.
      </p>
    </article>
  )
}

export function TermsPage() {
  return (
    <article className="article">
      <h1 className="article__title">Terms of Service</h1>
      <p className="article__meta">Last updated: {TERMS_UPDATED}</p>

      <p className="article__lede">
        By uploading a video to {SITE_NAME} you agree to these terms. They are deliberately short.
      </p>

      <h2>You must have the right to edit the video</h2>
      <p>
        Only upload videos you own or have permission to modify. Removing a watermark, credit or caption from someone
        else&rsquo;s work without their permission may infringe their rights — and in some places it is a separate
        offence regardless of copyright. You are responsible for what you upload and for what you do with the result.
      </p>

      <h2>What is not allowed</h2>
      <ul className="article__list">
        <li>Stripping attribution or copyright notices from work that is not yours.</li>
        <li>Removing identifying marks in order to pass off someone else&rsquo;s work as your own.</li>
        <li>Uploading illegal content, or content depicting the abuse of a real person.</li>
        <li>Automated or bulk use that degrades the service for others, or attempts to work around usage limits.</li>
      </ul>
      <p>We may refuse or remove any job, and block access, where we believe these terms are being broken.</p>

      <h2>Billing and credits</h2>
      <p>
        Prices, credit allowances and the applicable billing period are shown on the{' '}
        <a href="/pricing">Pricing page</a> and at checkout. One-time credit packages are charged once; their unused
        credits do not expire. Monthly subscriptions renew automatically at the price shown at checkout until
        cancelled. Subscription credits reset at the end of each billing period and do not roll over.
      </p>

      <h2>Refund policy</h2>
      <p>
        You may request a full refund for a one-time credit package within 14 days of purchase if none of that
        package&rsquo;s credits have been used. If any credits from the package have been used, a refund is not
        normally available, but contact us about duplicate charges, a billing error or a service problem and we will
        review your request.
      </p>
      <p>
        For a monthly subscription, you may request a full refund for a charge within 14 days of that charge if none
        of the subscription credits for that billing period have been used. If credits for that period have been
        used, a refund is not normally available; we will review billing errors and service problems individually.
        Cancelling a subscription does not by itself refund the current billing period.
      </p>
      <p>
        To request a refund, email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> with your account email,
        order or receipt number, purchase date and reason for the request. Please do not send card details. We aim to
        respond within five business days. Approved refunds are returned through the payment provider to the original
        payment method; the time until the money appears depends on the provider and your bank. Refunded credits may
        be removed, and account access may be temporarily restricted while a refund is reviewed.
      </p>
      <p>
        If a processing job fails, its reserved credits are returned to your account; this is a credit adjustment,
        not a refund to your payment method. Subscription credits are returned only while their original billing
        period remains active. Nothing in this policy limits any refund or cancellation rights available under
        applicable consumer law.
      </p>

      <h2>Cancel a monthly subscription</h2>
      <p>
        Sign in, open <a href="/pricing">Pricing</a>, and select &ldquo;Manage subscription&rdquo; to cancel through
        the customer portal. You can also contact <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> for help.
        Cancel before the next renewal to avoid the next charge. Cancellation stops future renewals; the current
        billing period and its remaining subscription credits continue until that period ends, after which unused
        subscription credits expire. One-time credits are not affected by cancellation.
      </p>

      <h2>The service is provided as it is</h2>
      <p>
        Text removal is a best-effort process, not a guarantee. Some footage will come back imperfect, and some jobs
        will fail. The service may be unavailable, slow, or changed without notice. We do not promise any particular
        quality of result, and we are not liable for any loss arising from using it — including the loss of a video you
        did not keep a copy of. Keep your originals.
      </p>

      <h2>Your content stays yours</h2>
      <p>
        You keep all rights to the videos you upload and to the results. We claim no licence over them beyond what is
        needed to produce your result, as described in the{' '}
        <a href="/privacy">Privacy Policy</a>.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </article>
  )
}
