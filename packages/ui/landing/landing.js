// The landing page: one input, and a way in when the server will not talk to a browser.
// Plain script (no framework, no build) so it paints at once; the viewer lives under ./v1/.
const VIEWER = './v1/'
const $ = (id) => document.getElementById(id)
const form = $('open')
const url = $('url')
const go = $('go')
const status = $('status')
const fallback = $('fallback')
const why = $('why')
const paste = $('paste')

const say = (msg, error = false) => {
  status.textContent = msg
  status.classList.toggle('error', error)
}

const looksPrivate = (u) => {
  try {
    const h = new URL(u).hostname
    return (
      h === 'localhost' ||
      /\.(local|internal|lan)$/i.test(h) ||
      /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) ||
      h === '[::1]'
    )
  } catch {
    return false
  }
}

const toViewer = (spec) => {
  // the colon and slashes of an address are legal in a query string, so the link stays readable
  const readable = encodeURIComponent(spec).replace(/%3A/gi, ':').replace(/%2F/gi, '/')
  location.href = `${VIEWER}?spec=${readable}`
}

/** Same store the viewer reads (`uploads` in `specbook-viewer`), so a pasted document opens there. */
function saveUpload(name, text) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('specbook-viewer', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('uploads', { keyPath: 'id' })
    r.onerror = () => reject(r.error)
    r.onsuccess = () => {
      const id = Math.random().toString(36).slice(2, 10)
      const tx = r.result.transaction('uploads', 'readwrite')
      tx.objectStore('uploads').put({ id, name, text, at: Date.now() })
      tx.oncomplete = () => resolve(id)
      tx.onerror = () => reject(tx.error)
    }
  })
}

async function openText(name, text) {
  if (!text.trim()) return say('There is nothing to open yet.', true)
  try {
    const id = await saveUpload(name, text)
    location.href = `${VIEWER}?upload=${id}`
  } catch {
    say('This browser would not store the document. Try another window, or a link instead.', true)
  }
}

/** What a visitor is told when the document's address cannot be read from here. */
const UNREADABLE = {
  local:
    'That address is on your own machine or network, which a hosted page cannot reach. Paste the document or choose the file instead.',
  cors: 'The browser could not read that address. The server may not allow other sites to fetch it (CORS), or the address is not reachable from here. Paste the document or choose the file; it works the same.',
}

function showFallback(reason) {
  why.textContent = reason
  fallback.hidden = false
  paste.focus()
}

/**
 * A GitHub file page, or its "Raw" link, becomes the address of the document itself. Same rule as
 * `rawGithub` in `src/viewer/share.ts`; this page is a plain script, so it keeps its own copy.
 */
function rawGithub(address) {
  try {
    const u = new URL(address)
    if (u.protocol !== 'https:' || !/^(www\.)?github\.com$/i.test(u.hostname)) return address
    const m = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(u.pathname)
    return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : address
  } catch {
    return address
  }
}

async function openUrl(raw) {
  const spec = rawGithub(raw.trim())
  fallback.hidden = true
  if (!/^https?:\/\//i.test(spec))
    return say('Enter an address starting with http:// or https://', true)
  if (looksPrivate(spec)) {
    say('', false)
    return showFallback(UNREADABLE.local)
  }
  go.disabled = true
  say('Checking the address…')
  try {
    // the viewer fetches it again; this only finds out, early and kindly, whether a browser may read it
    const res = await fetch(spec, { credentials: 'omit' })
    if (!res.ok) {
      go.disabled = false
      return say(`The server answered ${res.status} for that address.`, true)
    }
    toViewer(spec)
  } catch {
    go.disabled = false
    say('', false)
    showFallback(UNREADABLE.cors)
  }
}

// Back from the viewer can restore this page exactly as it was left (the back/forward cache): with the
// button disabled and "Checking the address…" still showing. Start clean when that happens.
addEventListener('pageshow', (e) => {
  if (!e.persisted) return
  go.disabled = false
  say('')
})

form.addEventListener('submit', (e) => {
  e.preventDefault()
  void openUrl(url.value)
})
$('open-paste').addEventListener('click', () => void openText('pasted document', paste.value))
$('file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0]
  if (f) await openText(f.name, await f.text())
})
for (const b of document.querySelectorAll('[data-spec]'))
  b.addEventListener('click', () => {
    url.value = b.dataset.spec
    void openUrl(b.dataset.spec)
  })

// While the visitor reads and types, fetch the viewer so it is on screen the moment they press Open:
// its modules are preloaded (compiled ahead), its styles and worker prefetched. It waits for the
// landing page itself to finish and for an idle moment, and does nothing on a data-saving connection.
function warmViewer() {
  if (navigator.connection?.saveData) return
  const el = document.getElementById('viewer-assets')
  if (!el) return
  let list
  try {
    list = JSON.parse(el.textContent || '{}')
  } catch {
    return
  }
  const add = (rel, href, as) => {
    const l = document.createElement('link')
    l.rel = rel
    l.href = href
    if (as) l.as = as
    document.head.append(l)
  }
  for (const h of list.modules ?? []) add('modulepreload', h)
  for (const h of list.prefetch ?? []) add('prefetch', h, h.endsWith('.css') ? 'style' : undefined)
}
const idle = window.requestIdleCallback ?? ((f) => setTimeout(f, 200))
if (document.readyState === 'complete') idle(warmViewer)
else addEventListener('load', () => idle(warmViewer), { once: true })

// a link that carries a spec goes straight in: `ui.specbook.dev/?spec=...`
const carried = new URLSearchParams(location.search).get('spec')
if (carried) toViewer(carried)

// "Open in Specbook" button: the markdown for a README, for any document served from a public address.
// The rules match the viewer's share menu, so a button never points at something only the author can open.
const SITE = 'https://ui.specbook.dev'
const SECRETISH =
  /^(token|access_token|id_token|refresh_token|key|api[-_]?key|apikey|secret|client_secret|password|passwd|pwd|auth|authorization|signature|sig|jwt|session|sid|code|x-amz-.*|x-goog-.*)$/i

const privateAddress = (host) => {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || /\.(local|internal|lan|home|corp|intranet|localhost)$/.test(h))
    return true
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

/** The address a button may link to, or the reason it may not. A GitHub file page becomes its raw file. */
function buttonTarget(raw) {
  let u
  try {
    u = new URL(raw.trim())
  } catch {
    return { error: 'Enter an address starting with http:// or https://' }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    return { error: 'Enter an address starting with http:// or https://' }
  if (privateAddress(u.hostname))
    return {
      error:
        'That address is only reachable from your own machine or network, so the button would not work for anyone else.',
    }
  if (u.username || u.password)
    return { error: 'The address contains a login, which the button would publish.' }
  for (const k of u.searchParams.keys())
    if (SECRETISH.test(k))
      return {
        error: `The address has a "${k}" parameter that looks like a credential, which the button would publish.`,
      }
  return { spec: rawGithub(u.toString()) }
}

const badgeUrl = $('badge-url')
const badgeNote = $('badge-note')
const badgeOut = $('badge-out')
const badgeMd = $('badge-md')
const badgeCopy = $('badge-copy')
const badgeCopyLabel = $('badge-copy-label')
const badgeImage = badgeNote.innerHTML

badgeUrl.addEventListener('input', () => {
  const value = badgeUrl.value.trim()
  badgeOut.hidden = true
  badgeNote.classList.remove('error')
  if (!value) {
    badgeNote.innerHTML = badgeImage
    return
  }
  const t = buttonTarget(value)
  if (t.error) {
    badgeNote.textContent = t.error
    badgeNote.classList.add('error')
    return
  }
  const readable = encodeURIComponent(t.spec).replace(/%3A/gi, ':').replace(/%2F/gi, '/')
  badgeNote.innerHTML = badgeImage
  badgeMd.textContent = `[![Open in Specbook](${SITE}/badge.svg)](${SITE}/v1/?spec=${readable})`
  badgeOut.hidden = false
  badgeCopyLabel.textContent = 'Copy'
})

badgeCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(badgeMd.textContent)
    badgeCopyLabel.textContent = 'Copied'
  } catch {
    // no clipboard permission: select the text so Ctrl/Cmd+C does it
    const r = document.createRange()
    r.selectNodeContents(badgeMd)
    const sel = getSelection()
    sel?.removeAllRanges()
    sel?.addRange(r)
    badgeCopyLabel.textContent = 'Press Ctrl/Cmd+C'
  }
})
