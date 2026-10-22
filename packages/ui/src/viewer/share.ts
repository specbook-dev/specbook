/**
 * Whether the page in front of someone can be shared as a link, and the links to do it with. A link is
 * only offered when everyone who opens it would get the same result: the document came from a public
 * address (a spec fetched by the browser from our origin, so it allows our origin for everyone), and
 * the address carries no credential.
 */

export type ViewerSource = { kind: 'url'; url: string } | { kind: 'text'; name?: string }

const SECRETISH =
  /^(token|access_token|id_token|refresh_token|key|api[-_]?key|apikey|secret|client_secret|password|passwd|pwd|auth|authorization|signature|sig|jwt|session|sid|code|x-amz-.*|x-goog-.*)$/i

const PRIVATE_HOST = /\.(local|internal|lan|home|corp|intranet|localhost)$/i

function privateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || PRIVATE_HOST.test(h)) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  return h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h)
}

/**
 * Why a hosted page could not read an address: it is on the visitor's own machine or network (a `file:` address,
 * `localhost`, a private range), or the server it names does not let other sites fetch from it.
 */
export function unreadableWhy(address: string): 'local' | 'cors' {
  try {
    const u = new URL(address)
    return u.protocol === 'file:' || privateAddress(u.hostname) ? 'local' : 'cors'
  } catch {
    return 'cors'
  }
}

/**
 * A spec address in a link: the colon and slashes of a URL are legal in a query string and stay as they
 * are, so the link reads as `?spec=https://host/openapi.json`; `&`, `#` and `%` are still escaped.
 */
export const softEncode = (s: string) =>
  encodeURIComponent(s).replace(/%3A/gi, ':').replace(/%2F/gi, '/')

/**
 * The address of a file as GitHub serves it to programs. A file page (`github.com/o/r/blob/<ref>/<path>`) and
 * its "Raw" link (`github.com/o/r/raw/<ref>/<path>`, which redirects without CORS headers) are HTML or a
 * redirect; the document itself is at `raw.githubusercontent.com/o/r/<ref>/<path>`. Anything else is
 * returned unchanged. The landing page keeps a copy of this (`landing/landing.js`, plain script).
 */
export function rawGithub(address: string): string {
  let u: URL
  try {
    u = new URL(address)
  } catch {
    return address
  }
  if (u.protocol !== 'https:' || !/^(www\.)?github\.com$/i.test(u.hostname)) return address
  const m = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(u.pathname)
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : address
}

export type Shareable = { ok: true; spec: string } | { ok: false; reason: string }

export function shareable(source: ViewerSource | undefined): Shareable {
  if (!source || source.kind === 'text')
    return {
      ok: false,
      reason:
        'This document was pasted or opened from a file, so there is no address to link to. Put the file somewhere public (a GitHub raw link or a Gist works) and open that address to get a link.',
    }
  let u: URL
  try {
    u = new URL(source.url)
  } catch {
    return { ok: false, reason: 'The document address is not a valid link.' }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    return { ok: false, reason: 'Only http and https addresses can be linked.' }
  if (privateAddress(u.hostname))
    return {
      ok: false,
      reason:
        'That address is only reachable from your own machine or network, so a link would not work for anyone else.',
    }
  if (u.username || u.password)
    return { ok: false, reason: 'The address contains a login, which a link would publish.' }
  for (const k of u.searchParams.keys())
    if (SECRETISH.test(k))
      return {
        ok: false,
        reason: `The address has a "${k}" parameter that looks like a credential, which a link would publish.`,
      }
  return { ok: true, spec: u.toString() }
}

export interface ShareLinks {
  link: string
  title: string
  targets: { id: string; label: string; href: string }[]
}

/** `location` is the viewer's own (origin, path and the hash of the operation being looked at). */
export function shareLinks(
  where: { origin: string; pathname: string; hash: string },
  spec: string,
  apiTitle: string,
): ShareLinks {
  const link = `${where.origin}${where.pathname}?spec=${softEncode(spec)}${where.hash}`
  const title = `Exploring ${apiTitle} in Specbook`
  const q = (o: Record<string, string>) => new URLSearchParams(o).toString()
  return {
    link,
    title,
    targets: [
      {
        id: 'x',
        label: 'X',
        href: `https://twitter.com/intent/tweet?${q({ text: title, url: link })}`,
      },
      {
        id: 'reddit',
        label: 'Reddit',
        href: `https://www.reddit.com/submit?${q({ url: link, title })}`,
      },
      {
        id: 'hn',
        label: 'Hacker News',
        href: `https://news.ycombinator.com/submitlink?${q({ u: link, t: title })}`,
      },
      {
        id: 'linkedin',
        label: 'LinkedIn',
        href: `https://www.linkedin.com/sharing/share-offsite/?${q({ url: link })}`,
      },
    ],
  }
}
