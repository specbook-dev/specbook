import { createWireHandler, parseWireCall } from '@specbook/core/internal'
import { createAudit } from './audit'
import { createHost } from './host'
import { createState } from './state'

const state = createState(chrome.storage.local)
const audit = createAudit(chrome.storage.session)

const host = createHost({
  state,
  audit,
  hasPermission: (origin) => chrome.permissions.contains({ origins: [`${origin}/*`] }),
  siteEnabled: async (site) => {
    const builtIn = (chrome.runtime.getManifest().content_scripts ?? []).flatMap(
      (c) => c.matches ?? [],
    )
    return (
      builtIn.some((m) => m.replace(/\/\*$/, '') === site) || (await state.sites()).includes(site)
    )
  },
  async openGrant(site, origins, opts) {
    const url = chrome.runtime.getURL(
      `popup.html?site=${encodeURIComponent(site)}&need=${encodeURIComponent(origins.join(','))}${
        opts?.writes ? '&writes=1' : ''
      }`,
    )
    await chrome.windows.create({ url, type: 'popup', width: 420, height: 640 })
  },
})
const handler = createWireHandler(host)

// The page reaches this worker only through the content script, one line (port) per call. The site is the
// origin the browser attached to that line: nothing the page said about itself is used.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'specbook') return
  const sender = port.sender
  let site: string | undefined = sender?.origin
  if (!site && sender?.url) {
    try {
      site = new URL(sender.url).origin
    } catch {
      /* no usable origin */
    }
  }
  if (!site || site === 'null') {
    port.disconnect()
    return
  }
  const who = { site }
  const started = new Set<string>()

  port.onMessage.addListener(async (message) => {
    const call = parseWireCall((message as { call?: unknown } | null)?.call)
    if (!call) return
    if (call.type === 'fetch') started.add(call.id)
    const reply = await handler.handle(call, who)
    if (reply) {
      try {
        port.postMessage({ reply })
      } catch {
        /* the page went away while the call ran */
      }
    }
  })
  // the page, the tab or the frame closed (or the page aborted): stop what was started
  port.onDisconnect.addListener(() => {
    for (const id of started) void handler.handle({ v: 1, type: 'abort', id }, who)
  })
})
