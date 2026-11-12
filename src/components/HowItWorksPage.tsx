import { NavLink } from './Navbar'

/**
 * /how-it-works —— 一篇真正解释原理的长文。
 *
 * 这类页面的作用是接住"how to remove hardcoded subtitles"这类带着疑问词的
 * 长尾搜索。前提是它得真的回答问题:凑关键词的页面现在不会有排名,
 * 而一篇讲清楚了的文章会被人收藏和引用。
 */
export default function HowItWorksPage({ onNavigate }: { onNavigate: (to: string) => void }) {
  return (
    <article className="article">
      <h1 className="article__title">How AI removes subtitles from a video</h1>
      <p className="article__lede">
        Burned-in text is not a layer you can switch off. By the time a video reaches you, the subtitle has been baked
        into the pixels of every frame — it is as much a part of the picture as a face or a wall. Removing it means
        inventing what was behind it. Here is how that actually works.
      </p>

      <h2>Why you cannot just turn subtitles off</h2>
      <p>
        There are two kinds of subtitles. <strong>Soft subtitles</strong> travel alongside the video as a separate text
        track — an SRT file, or a track inside an MKV. Your player draws them on top at playback time, and a single
        click turns them off.
      </p>
      <p>
        <strong>Hardcoded subtitles</strong> — also called burned-in or open captions — were rendered into the frames
        when the video was exported. There is no track to disable. What you have is a picture with letters in it, and
        the information that used to be behind those letters is simply gone from that frame.
      </p>

      <h2>The three things that have to happen</h2>

      <h3>1. Find the text</h3>
      <p>
        A detection model runs over the frames and marks where caption text appears. This is harder than it sounds.
        Subtitles come in different sizes, fonts, colours and scripts; they may have an outline or a drop shadow; they
        may sit over a bright sky in one shot and a dark interior in the next.
      </p>
      <p>
        The detector also has to avoid false positives, which is why it concentrates on the region where subtitles
        actually live — the band across the lower and central part of the frame. A street sign or a book cover inside
        the scene is text you almost certainly want to keep, and so is a station logo in the corner.
      </p>

      <h3>2. Build a mask</h3>
      <p>
        The detected regions become a per-frame mask: a black-and-white stencil saying &ldquo;replace these pixels,
        leave the rest alone&rdquo;. The mask is usually grown a few pixels beyond the glyphs so that anti-aliased
        edges, outlines and shadows are included. Miss those and you get a faint ghost of the lettering in the output,
        which is often more distracting than the subtitle was.
      </p>
      <p>
        Because the mask is computed per frame, subtitles that move, fade or change between lines are tracked rather
        than averaged into one static box.
      </p>

      <h3>3. Inpaint the gap</h3>
      <p>
        This is the part that decides whether the result looks clean or looks edited. <strong>Inpainting</strong> fills
        the masked area with plausible content. A naive approach samples the pixels immediately around the hole and
        blends inward — which is why cheap tools produce a smudge.
      </p>
      <p>
        Video inpainting can do much better, because it has a dimension that photo editing does not:{' '}
        <strong>time</strong>. The camera moves, the subject moves, the background shifts. A patch of jacket hidden
        behind a subtitle in frame 100 is very often visible in frame 60 or frame 140. The model estimates how pixels
        flow between frames, pulls the real background forward or backward from the frames where it <em>is</em>{' '}
        visible, and only falls back on generating new content where no frame ever saw behind the text.
      </p>
      <p>
        That is also why a static shot with subtitles over a busy, constantly changing background is the hardest case,
        and why a moving camera often gives a <em>better</em> result than a locked-off one.
      </p>

      <h2>What to expect</h2>
      <ul className="article__list">
        <li>
          <strong>Clean backgrounds come out best.</strong> Subtitles over a wall, a sky, clothing or a softly blurred
          background are usually indistinguishable from footage that never had them.
        </li>
        <li>
          <strong>Detailed, static backgrounds are hardest.</strong> Fine repeating texture behind text that never
          moves gives the model the least to work with.
        </li>
        <li>
          <strong>Very large text is harder than small text.</strong> A full-width title covers more unknown background
          than a line of subtitles at the bottom of the frame.
        </li>
        <li>
          <strong>Text outside the caption band usually stays.</strong> Corner logos and banners pinned to the top edge
          are not what the subtitle detector is looking for. See{' '}
          <NavLink href="/" onNavigate={onNavigate}>
            what it does and does not handle
          </NavLink>
          .
        </li>
        <li>
          <strong>Quality is preserved where nothing changed.</strong> Only the masked region is rewritten; resolution
          and frame rate stay as they were.
        </li>
      </ul>

      <h2>A practical tip</h2>
      <p>
        If a clip comes back with faint traces, try trimming it to just the section you need and running that. Shorter
        clips keep the model&rsquo;s attention on a narrower range of backgrounds, and you will usually get a cleaner
        result than processing a long video in one pass.
      </p>

      <p className="article__cta">
        <NavLink href="/" onNavigate={onNavigate} className="btn btn--primary">
          Try it on your video
        </NavLink>
      </p>
    </article>
  )
}
