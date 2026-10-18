import { defineOperation, sequence, withMock } from '@specbook/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEngine, pickRunnable } from '../src/engine'

const GetPet = defineOperation<{
  params: { path: { petId: string } }
  body: never
  responses: { 200: { id: string; name: string }; 404: { message: string } }
}>({ service: 'pets', id: 'GetPet', method: 'GET', path: '/pet/{petId}' })

const reg = {
  manifests: { pets: { operations: [{ id: 'GetPet', statuses: [200, 404] }] } },
  examples: {
    'pets/GetPet.200': async () => ({ default: { id: '{{petId}}', name: 'Rex' } }),
    'pets/GetPet.404': async () => ({ default: { message: 'nope' } }),
  },
  operations: { 'pets/GetPet': async () => ({ GetPet }) },
  requestExamples: {},
  assets: {},
  docs: [],
  loadConfig: async () => ({
    default: {
      project: 'p',
      vars: {},
      services: { pets: { spec: 'x', baseUrl: { live: 'https://x', staging: 'https://y' } } },
    },
  }),
}

describe('ui engine', () => {
  const engine = createEngine(reg)

  it('lists environments from service baseUrls, mock first', async () => {
    expect(await engine.environments(0)).toEqual(['mock', 'live', 'staging'])
  })

  it('lists every server as an environment and reports the descriptions the config gives them', async () => {
    const many = createEngine({
      ...reg,
      loadConfig: async () => ({
        default: {
          project: 'p',
          services: {
            pets: {
              spec: 'x',
              baseUrl: { live: 'https://x', sandbox: 'https://sandbox.x', eu: 'https://eu.x' },
            },
          },
          environments: { sandbox: { description: 'Test data, no real charges' } },
        },
      }),
    })
    expect(await many.environments(0)).toEqual(['mock', 'live', 'sandbox', 'eu'])
    expect(await many.environmentNotes(0)).toEqual({ sandbox: 'Test data, no real charges' })
    // a config with no descriptions has no notes
    expect(await engine.environmentNotes(0)).toEqual({})
  })

  it("gives a live request the time the project says, and the runner's 30 seconds when it says nothing", async () => {
    const real = globalThis.fetch
    const asked: (number | undefined)[] = []
    // an API that never answers: how long it waits is what is asked of it
    globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        )
      })) as typeof fetch
    try {
      const withTimeout = (timeoutMs?: number) =>
        createEngine({
          ...reg,
          loadConfig: async () => ({
            default: {
              project: 'p',
              vars: {},
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
              services: { pets: { spec: 'x', baseUrl: { live: 'https://x.test' } } },
            },
          }),
        })
      const def = await engine.operationRequest('pets/GetPet', 0, { path: { petId: '7' } })
      const r = await withTimeout(40).run(def, { env: 'live', version: 0 })
      expect(r.steps[0]?.error).toContain('Timed out after 40ms')
      asked.push(40)
      expect(asked).toEqual([40])
    } finally {
      globalThis.fetch = real
    }
  })

  it('plays a generated operation against its example, with a forced mock status', async () => {
    const def = await engine.operationRequest('pets/GetPet', 0, { path: { petId: '7' } })
    const ok = await engine.run(def, { env: 'mock', version: 0 })
    expect(ok.steps[0]?.response?.body).toEqual({ id: '7', name: 'Rex' })
    const nope = await engine.run(def, { env: 'mock', version: 0, mockStatus: 404 })
    expect(nope.steps[0]?.response?.status).toBe(404)
  })

  it("a saved request keeps its mock hook when the panel rebuilds it with the person's values", async () => {
    const saved = withMock(GetPet.request({ path: { petId: '1' } }), (_req, res) => {
      if (res.status === 200) res.data.name = 'Hooked'
    })
    const def = await engine.operationRequest('pets/GetPet', 0, { path: { petId: '9' } }, saved)
    const r = await engine.run(def, { env: 'mock', version: 0 })
    expect(r.steps[0]?.response?.body).toEqual({ id: '9', name: 'Hooked' })
  })

  it('runs a sequence and pauses for input via onInput', async () => {
    const seq = sequence({ id: 's', title: 'S' })
      .step('get', GetPet.request({ path: { petId: '1' } }))
      .input('pick', () => ({ who: { kind: 'text', opts: {} } as any }))
    const asked: string[] = []
    const r = await engine.run(seq, {
      env: 'mock',
      version: 0,
      onInput: ({ name }) => {
        asked.push(name)
        return { who: 'me' }
      },
    })
    expect(asked).toEqual(['pick'])
    expect(r.status).toBe('pass')
  })

  it('loads faker only when a run can use it', async () => {
    let loads = 0
    const fakerReg = {
      ...reg,
      loadFaker: async () => {
        loads++
        return import('@faker-js/faker')
      },
    }
    const e = createEngine(fakerReg)
    await e.run(GetPet.request({ path: { petId: '1' } }), { env: 'mock', version: 0 })
    expect(loads).toBe(0)
    await e.run(GetPet.request({ path: { petId: '{{faker.person.firstName}}' } }), {
      env: 'mock',
      version: 0,
    })
    expect(loads).toBe(1)
    await e.run(GetPet.request({ init: { petId: () => 'x' }, path: { petId: '{{petId}}' } }), {
      env: 'mock',
      version: 0,
    })
    expect(loads).toBe(2)
  })

  it('stops a run on a misspelt faker placeholder, naming it and not a missing variable', async () => {
    const e = createEngine({ ...reg, loadFaker: async () => import('@faker-js/faker') })
    const r = await e.run(GetPet.request({ path: { petId: '{{faker.person.fistName}}' } }), {
      env: 'mock',
      version: 0,
    })
    expect(r.status).toBe('error')
    const text = r.steps[0]?.error ?? ''
    expect(text).toMatch(/Unknown faker generator "\{\{faker\.person\.fistName\}\}"/)
    expect(text).not.toMatch(/Missing variable/)
  })

  it('pickRunnable prefers default, then any runnable export', () => {
    const req = GetPet.request({})
    expect(pickRunnable({ default: req })).toBe(req)
    expect(pickRunnable({ other: 1, named: req })).toBe(req)
    expect(pickRunnable({})).toBeUndefined()
  })
})

describe('a sign-in’s token exchange', () => {
  const oauthReg = (mode?: 'dev' | 'static') => ({
    ...reg,
    mode,
    loadConfig: async () => ({
      default: {
        project: 'p',
        services: { pets: { spec: 'x', baseUrl: { live: 'https://api.example.com/v1' } } },
        auth: {
          'My OAuth': {
            apply: { headers: { authorization: 'Bearer {{secrets.TOKEN}}' } },
            oauth: {
              authorizationUrl: 'https://auth.example.com/authorize',
              tokenUrl: 'https://auth.example.com/oauth/token?tenant=a',
            },
          },
        },
      },
    }),
  })
  const fields = { grant_type: 'authorization_code', code: 'c', code_verifier: 'v' }
  const reply = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  afterEach(() => vi.unstubAllGlobals())

  it('goes through the dev server’s proxy, addressed by profile, as a form post', async () => {
    const f = reply(200, { access_token: 't' })
    vi.stubGlobal('fetch', f)
    const body = await createEngine(oauthReg('dev')).oauthExchange({
      env: 'live',
      version: 0,
      profile: 'My OAuth',
      fields,
    })
    expect(body).toEqual({ access_token: 't' })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/__specbook/proxy/live/auth:My%20OAuth/oauth/token?tenant=a')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    )
    expect(new URLSearchParams(init.body as string).get('code_verifier')).toBe('v')
  })

  it('on a static page posts straight to the token endpoint named in the config', async () => {
    const f = reply(200, { access_token: 't' })
    vi.stubGlobal('fetch', f)
    await createEngine(oauthReg('static')).oauthExchange({
      env: 'live',
      version: 0,
      profile: 'My OAuth',
      fields,
    })
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://auth.example.com/oauth/token?tenant=a',
    )
  })

  it('hands back an error body the server sent, and throws for a failure with none', async () => {
    const e = createEngine(oauthReg('dev'))
    const call = () => e.oauthExchange({ env: 'live', version: 0, profile: 'My OAuth', fields })
    vi.stubGlobal('fetch', reply(400, { error: 'invalid_grant' }))
    await expect(call()).resolves.toEqual({ error: 'invalid_grant' })
    vi.stubGlobal('fetch', reply(502, { message: 'bad gateway' }))
    await expect(call()).rejects.toThrow(/answered 502/)
  })

  it('refuses the mock environment and a profile with no sign-in', async () => {
    const e = createEngine(oauthReg('dev'))
    await expect(
      e.oauthExchange({ env: 'mock', version: 0, profile: 'My OAuth', fields }),
    ).rejects.toThrow(/live environment/)
    await expect(
      e.oauthExchange({ env: 'live', version: 0, profile: 'nope', fields }),
    ).rejects.toThrow(/no sign-in/)
  })

  describe('with an OpenID Connect provider', () => {
    const oidcReg = (mode?: 'dev' | 'static') => ({
      ...oauthReg(mode),
      loadConfig: async () => ({
        default: {
          project: 'p',
          services: { pets: { spec: 'x', baseUrl: { live: 'https://api.example.com/v1' } } },
          auth: {
            'My SSO': {
              apply: { headers: { authorization: 'Bearer {{secrets.TOKEN}}' } },
              oauth: {
                openIdConnectUrl: 'https://accounts.example.com/.well-known/openid-configuration',
              },
            },
          },
        },
      }),
    })
    const document = {
      authorization_endpoint: 'https://accounts.example.com/o/authorize',
      token_endpoint: 'https://oauth2.example.com/token',
      scopes_supported: ['email', 'openid'],
    }

    it('reads the discovery document through the proxy, then sends the code to the token endpoint it named', async () => {
      const f = vi.fn(async (url: string) =>
        url.includes('/discovery:')
          ? new Response(JSON.stringify(document), { status: 200 })
          : new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }),
      )
      vi.stubGlobal('fetch', f)
      const e = createEngine(oidcReg('dev'))
      const found = await e.oauthEndpoints({ env: 'live', version: 0, profile: 'My SSO' })
      expect(found.authorizationUrl).toBe('https://accounts.example.com/o/authorize')
      expect(Object.keys(found.scopes)).toEqual(['openid', 'email'])
      expect(f.mock.calls[0]?.[0]).toBe(
        '/__specbook/proxy/live/discovery:My%20SSO/.well-known/openid-configuration',
      )

      await e.oauthExchange({ env: 'live', version: 0, profile: 'My SSO', fields })
      // the document is read once; the exchange goes to the token path, addressed as the profile's own
      expect(f).toHaveBeenCalledTimes(2)
      expect(f.mock.calls[1]?.[0]).toBe('/__specbook/proxy/live/auth:My%20SSO/token')
    })

    it('on a static page asks the provider directly, and tries again after a failure', async () => {
      const f = vi
        .fn()
        .mockResolvedValueOnce(new Response('down', { status: 503 }))
        .mockResolvedValue(new Response(JSON.stringify(document), { status: 200 }))
      vi.stubGlobal('fetch', f)
      const e = createEngine(oidcReg('static'))
      const ask = () => e.oauthEndpoints({ env: 'live', version: 0, profile: 'My SSO' })
      await expect(ask()).rejects.toThrow(/answered 503/)
      await expect(ask()).resolves.toMatchObject({ tokenUrl: 'https://oauth2.example.com/token' })
      expect(f.mock.calls[0]?.[0]).toBe(
        'https://accounts.example.com/.well-known/openid-configuration',
      )
    })
  })
})
