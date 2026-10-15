import { useState } from 'preact/hooks'
import { route } from '../nav'
import { ShareIcon } from '../panel/icons'
import { shareable, shareLinks } from '../viewer/share'

/**
 * Share, for the hosted viewer only (a project's own site has no viewer global). The menu says why when a
 * link would not work for others, rather than offering one that fails for whoever opens it.
 */
export function ShareMenu() {
  const v = globalThis.__SPECBOOK_VIEWER__
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  if (!v?.source) return null
  void route.value // re-render when the operation changes, so the link follows it

  const can = shareable(v.source)
  const links = can.ok
    ? shareLinks(
        { origin: location.origin, pathname: location.pathname, hash: location.hash },
        can.spec,
        v.open.title,
      )
    : undefined

  const copy = async () => {
    if (!links) return
    try {
      await navigator.clipboard.writeText(links.link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* the link is shown in the menu to copy by hand */
    }
  }

  return (
    <div class="share">
      <button
        type="button"
        class="btn"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Share"
        onClick={() => setOpen(!open)}
      >
        <ShareIcon />
        <span class="share-label">Share</span>
      </button>
      {open && (
        <div class="share-pop" role="menu">
          {links ? (
            <>
              <input
                class="share-link"
                readOnly
                value={links.link}
                aria-label="Link to this view"
                onFocus={(e) => (e.target as HTMLInputElement).select()}
              />
              <div class="share-actions">
                <button type="button" class="btn primary" onClick={copy}>
                  {copied ? 'Copied' : 'Copy link'}
                </button>
                {typeof navigator.share === 'function' && (
                  <button
                    type="button"
                    class="btn"
                    onClick={() =>
                      void navigator.share({ title: links.title, url: links.link }).catch(() => {})
                    }
                  >
                    Share…
                  </button>
                )}
              </div>
              <ul class="share-targets">
                {links.targets.map((t) => (
                  <li>
                    <a href={t.href} target="_blank" rel="noopener noreferrer">
                      {t.label}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p class="muted">{can.ok ? '' : can.reason}</p>
          )}
        </div>
      )}
    </div>
  )
}
