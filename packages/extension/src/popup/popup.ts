import { createAudit } from '../audit'
import { createState } from '../state'

const state = createState(chrome.storage.local)
const audit = createAudit(chrome.storage.session)
const app = document.getElementById('app') as HTMLElement
const params = new URLSearchParams(location.search)

type Child = Node | string | false | null | undefined
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<{
    class: string
    type: string
    value: string
    placeholder: string
    title: string
  }> & {
    onclick?: () => void
  } = {},
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  const { onclick, ...attrs } = props
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, v as string)
  if (onclick) el.addEventListener('click', onclick)
  for (const k of kids) if (k) el.append(k)
  return el
}

/** A labelled checkbox, set when it is made and writing back when it changes. */
function toggle(
  text: string,
  title: string,
  checked: boolean,
  onChange: (on: boolean) => void,
  /** on and cannot be turned off here */
  locked = false,
) {
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = checked
  box.disabled = locked
  box.addEventListener('change', () => onChange(box.checked))
  return h('label', { title }, box, text)
}

const patternOf = (origin: string) => `${origin}/*`
const hostOf = (origin: string) => {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}
const isPrivate = (origin: string) =>
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[::1\])/.test(
    hostOf(origin),
  ) || /\.(localhost|local|internal|lan|home|corp|intranet)(:\d+)?$/.test(hostOf(origin))

async function currentSite(): Promise<string | undefined> {
  const forced = params.get('site')
  if (forced) return forced
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  try {
    const u = new URL(tab?.url ?? '')
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : undefined
  } catch {
    return undefined
  }
}

const builtInSites = () =>
  (chrome.runtime.getManifest().content_scripts ?? [])
    .flatMap((c) => c.matches ?? [])
    .map((m) => m.replace(/\/\*$/, ''))

/** Allow one API for one site. `permissions.request` has to be called from the click itself. */
function allow(site: string, origin: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [patternOf(origin)] }).then(async (ok) => {
    if (ok) await state.allow(site, origin)
    return ok
  })
}

async function enableSite(site: string) {
  const pattern = patternOf(site)
  const ok = await chrome.permissions.request({ origins: [pattern] })
  if (!ok) return
  const id = `site:${site}`
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [id] })
  } catch {
    /* not registered yet */
  }
  await chrome.scripting.registerContentScripts([
    {
      id,
      matches: [pattern],
      js: ['content.js'],
      runAt: 'document_start',
      allFrames: true,
      persistAcrossSessions: true,
    },
  ])
  await state.addSite(site)
  // the page that is open now: no reload needed
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id !== undefined) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.js'],
      })
    } catch {
      /* the page will have it on its next load */
    }
  }
}

async function disableSite(site: string) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [`site:${site}`] })
  } catch {
    /* already gone */
  }
  await state.removeSite(site)
  try {
    await chrome.permissions.remove({ origins: [patternOf(site)] })
  } catch {
    /* held by something else */
  }
}

async function revoke(site: string, origin: string) {
  const unused = await state.revoke(site, origin)
  if (unused) {
    try {
      await chrome.permissions.remove({ origins: [patternOf(origin)] })
    } catch {
      /* not held */
    }
  }
}

/** `closeWhenDone`: the person just answered, so a window opened to ask something closes once all of it is answered */
async function render(closeWhenDone = false) {
  const site = await currentSite()
  const need = (params.get('need') ?? '').split(',').filter(Boolean)
  const [grants, sites, calls] = await Promise.all([state.grants(), state.sites(), audit.list()])
  const mine = site ? (grants[site] ?? {}) : {}
  const stillNeeded = need.filter((o) => !(o in mine))
  // a page that may read an API asked to change it too
  const wantsWrites = params.get('writes') === '1'
  const stillReadOnly = wantsWrites ? need.filter((o) => o in mine && !mine[o]?.writes) : []
  const nodes: Node[] = [h('h1', {}, 'Specbook')]

  // 1. this site
  if (!site) {
    nodes.push(
      h('p', { class: 'muted' }, 'Open a page that uses Specbook, then click the icon again.'),
    )
  } else {
    nodes.push(h('p', {}, h('b', {}, hostOf(site))))
    if (builtInSites().includes(site)) {
      nodes.push(h('p', { class: 'muted' }, 'Specbook is on for this site.'))
    } else if (sites.includes(site)) {
      nodes.push(
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'grow muted' }, 'Extension is enabled on this site.'),
          h('button', { onclick: () => disableSite(site).then(() => render()) }, 'Disable'),
        ),
      )
    } else {
      nodes.push(
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'grow muted' }, 'Extension is not enabled on this site.'),
          h(
            'button',
            { class: 'primary', onclick: () => enableSite(site).then(() => render()) },
            'Enable',
          ),
        ),
      )
    }
  }

  // 2. the APIs this site may call; what the page is asking about comes first and is highlighted, and the
  //    rest follow with the newest first, so the window has one list and no separate question to answer
  if (site) {
    const granted = Object.entries(mine).sort(([, a], [, b]) => b.at - a.at)
    nodes.push(h('h2', {}, 'APIs this site may call'))
    if (!stillNeeded.length && !granted.length) nodes.push(h('p', { class: 'muted' }, 'None yet.'))
    else
      nodes.push(
        h(
          'p',
          { class: 'muted' },
          'Specbook sends only the requests this site asks for, to these APIs, with no cookies. Modify data lets it send POST, PUT, PATCH and DELETE. Without it, it can only send GET, HEAD and OPTIONS.',
        ),
      )
    // an API the page has asked about and the person has not allowed yet
    for (const origin of stillNeeded) {
      // reading and changing can be allowed in one answer; reading alone is the default
      const andChanges = document.createElement('input')
      andChanges.type = 'checkbox'
      // a private or local address is refused unless the person allows it, so it is offered in the same answer: otherwise
      // the first call fails and the switch has to be found among the allowed APIs afterwards
      const andPrivate = document.createElement('input')
      andPrivate.type = 'checkbox'
      nodes.push(
        h(
          'div',
          { class: 'row api asking' },
          h('span', { class: 'grow' }, hostOf(origin)),
          h(
            'button',
            {
              class: 'primary',
              onclick: () =>
                void allow(site, origin).then(async (ok) => {
                  if (ok && andChanges.checked) await state.setFlag(site, origin, 'writes', true)
                  if (ok && andPrivate.checked) await state.setFlag(site, origin, 'private', true)
                  await render(ok)
                }),
            },
            'Allow',
          ),
          h(
            'div',
            { class: 'flags' },
            h(
              'label',
              {
                title:
                  'Lets this site send POST, PUT, PATCH and DELETE. Without this it can only send GET, HEAD and OPTIONS.',
              },
              andChanges,
              'Modify data',
            ),
            isPrivate(origin) &&
              h(
                'label',
                {
                  title:
                    'This is a private or local address, such as localhost. Without this the site cannot reach it.',
                },
                andPrivate,
                'Allow private',
              ),
          ),
        ),
      )
    }
    for (const [origin, p] of granted) {
      nodes.push(
        h(
          'div',
          // asked about again, for changes this time
          { class: `row api${stillReadOnly.includes(origin) ? ' asking' : ''}` },
          h('span', { class: 'grow' }, hostOf(origin)),
          h('button', { onclick: () => revoke(site, origin).then(() => render()) }, 'Revoke'),
          // the switches are a line of their own: with both of them and a long address, Revoke would be pushed to a line alone
          h(
            'div',
            { class: 'flags' },
            // one way: once allowed, changes stay allowed until the API is revoked, which takes everything away
            toggle(
              'Modify data',
              p.writes
                ? 'Stays allowed until you revoke this API.'
                : 'Lets this site send POST, PUT, PATCH and DELETE. Without this it can only send GET, HEAD and OPTIONS.',
              p.writes,
              // redrawn once saved, so the switch locks the moment it is ticked
              (on) => void state.setFlag(site, origin, 'writes', on).then(() => render(true)),
              p.writes,
            ),
            isPrivate(origin) &&
              toggle(
                'Allow private',
                'A private or local address, such as localhost.',
                p.private,
                (on) => void state.setFlag(site, origin, 'private', on),
              ),
          ),
        ),
      )
    }
  }

  // 4. what happened
  nodes.push(h('h2', {}, 'Recent calls'))
  const recent = calls.slice(-12).reverse()
  nodes.push(
    ...(recent.length
      ? recent.map((c) =>
          h(
            'div',
            { class: 'row log' },
            h(
              'span',
              { class: `grow${c.outcome === 'ok' ? '' : ' bad'}` },
              `${c.method} ${hostOf(c.origin)}${c.path}`,
            ),
            h(
              'span',
              { class: 'muted' },
              c.outcome === 'ok' ? String(c.status ?? '') : (c.code ?? 'error'),
            ),
          ),
        )
      : [h('p', { class: 'muted' }, 'Nothing yet.')]),
  )

  app.replaceChildren(...nodes)

  // a window opened to ask something has nothing left to ask
  if (closeWhenDone && site && need.length && !stillNeeded.length && !stillReadOnly.length)
    window.close()
}

void render()
