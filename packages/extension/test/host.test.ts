import { createWireHandler, type WireAuditEvent } from '@specbook/core/internal'
import { describe, expect, it, vi } from 'vitest'
import { createHost } from '../src/host'
import { createState } from '../src/state'
import { memoryArea } from './fake'

const SITE = 'https://ui.specbook.dev'
const API = 'https://api.example.com'

function setup(opts: { permitted?: string[]; builtIn?: string[] } = {}) {
  const state = createState(memoryArea())
  const permitted = new Set(opts.permitted ?? [API])
  const openGrant = vi.fn()
  const audit: WireAuditEvent[] = []
  const sent: { url: string; auth: string | null }[] = []
  const host = createHost({
    state,
    hasPermission: async (o) => permitted.has(o),
    openGrant,
    siteEnabled: (s) => (opts.builtIn ?? [SITE]).includes(s),
    audit: { push: (e) => audit.push(e) },
    fetch: (async (url: string, init?: RequestInit) => {
      sent.push({ url, auth: new Headers(init?.headers).get('authorization') })
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch,
  })
  return { state, host, handler: createWireHandler(host), permitted, openGrant, audit, sent }
}

const fetchCall = (path = '/pets', init: Record<string, unknown> = {}) => ({
  v: 1 as const,
  type: 'fetch' as const,
  id: 'c1',
  req: { method: 'GET', url: `${API}${path}`, headers: {}, ...init },
})

describe('what the extension lets through', () => {
  it('needs the person’s allow AND the browser’s own permission', async () => {
    const { state, host, permitted } = setup()
    expect(await host.isGranted(SITE, API)).toBe(false)
    await state.allow(SITE, API)
    expect(await host.isGranted(SITE, API)).toBe(true)
    // revoked in the browser's own extension page, without this store being told
    permitted.delete(API)
    expect(await host.isGranted(SITE, API)).toBe(false)
  })

  it('reads the pair’s writes and private flags, off until set', async () => {
    const { state, host } = setup()
    await state.allow(SITE, API)
    expect(await host.allowsWrites?.(SITE, API)).toBe(false)
    expect(await host.allowsPrivate?.(SITE, API)).toBe(false)
    await state.setFlag(SITE, API, 'writes', true)
    expect(await host.allowsWrites?.(SITE, API)).toBe(true)
  })

  it('holds no keys: a placeholder that reaches it is refused, and nothing is sent', async () => {
    const { state, handler, sent } = setup()
    await state.allow(SITE, API)
    const reply = await handler.handle(
      fetchCall('/pets', { headers: { authorization: 'Bearer {{secrets.KEY}}' } }),
      { site: SITE },
    )
    expect(reply).toMatchObject({ type: 'error', code: 'missing-secrets' })
    expect(sent).toHaveLength(0)
  })

  it('puts a missing grant in front of the person, asking only about what is missing', async () => {
    const { handler, openGrant, state } = setup({ permitted: [API, 'https://b.example'] })
    await state.allow(SITE, API)
    await handler.handle(
      { v: 1, type: 'grant', apiOrigins: [API, 'https://b.example'] },
      { site: SITE },
    )
    // an ordinary grant carries no question about changes
    expect(openGrant).toHaveBeenCalledWith(SITE, ['https://b.example'], undefined)
  })

  it('puts a question about changes in front of the person, until they have answered it', async () => {
    const { handler, openGrant, state } = setup()
    await state.allow(SITE, API)
    const ask = () =>
      handler.handle({ v: 1, type: 'grant', apiOrigins: [API], writes: true }, { site: SITE })
    await ask()
    expect(openGrant).toHaveBeenCalledWith(SITE, [API], { writes: true })

    openGrant.mockClear()
    await state.setFlag(SITE, API, 'writes', true)
    await ask()
    expect(openGrant).not.toHaveBeenCalled()
  })

  it('reports whether the relay is on for a site', async () => {
    const { handler } = setup({ builtIn: [SITE] })
    expect(
      await handler.handle({ v: 1, type: 'status', apiOrigins: [] }, { site: SITE }),
    ).toMatchObject({
      pageEnabled: true,
    })
    expect(
      await handler.handle(
        { v: 1, type: 'status', apiOrigins: [] },
        { site: 'https://elsewhere.example' },
      ),
    ).toMatchObject({ pageEnabled: false })
  })

  it('records each call without its query string', async () => {
    const { state, handler, audit } = setup()
    await state.allow(SITE, API)
    await handler.handle(fetchCall('/pets?api_key=sk_in_query'), { site: SITE })
    expect(audit[0]).toMatchObject({ site: SITE, origin: API, path: '/pets', outcome: 'ok' })
    expect(JSON.stringify(audit)).not.toContain('sk_in_query')
  })
})
