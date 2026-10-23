import type { AuthProfile, SecurityRequirement, SpecbookConfig } from '@specbook/core'
import { describe, expect, it } from 'vitest'
import {
  authOptions,
  availability,
  choosable,
  neededProfiles,
  ordered,
  unservedSchemes,
} from '../src/auth-options'

const auth: Record<string, AuthProfile> = {
  key: { title: 'API key', scheme: 'api_key', apply: { headers: { api_key: '{{secrets.K}}' } } },
  tok: {
    title: 'OAuth sign-in',
    scheme: 'petstore_auth',
    apply: { headers: { authorization: 'Bearer {{secrets.T}}' } },
    oauth: { authorizationUrl: 'https://a.test/authorize', flow: 'implicit' },
  },
  cc: {
    title: 'Client credentials',
    scheme: 'petstore_auth',
    apply: { headers: { authorization: 'Bearer {{session.accessToken}}' } },
    oauth: {
      tokenUrl: 'https://a.test/t',
      clientId: '{{secrets.CID}}',
      clientSecret: '{{secrets.CS}}',
    },
  },
}
const cfg = {
  project: 'p',
  services: { pets: { spec: '', baseUrl: 'x', auth: ['key', 'tok', 'cc', 'ghost'] } },
  auth,
} as unknown as SpecbookConfig
const listed = ['key', 'tok', 'cc']

describe('authOptions', () => {
  it('lists the profiles the config has, saying what each takes and who may hold it', () => {
    const o = authOptions(cfg, 'pets')
    expect(o.map((x) => [x.name, x.kind])).toEqual([
      ['key', 'paste'],
      ['tok', 'sign-in'],
      ['cc', 'server'],
    ])
    expect(o[0]).toMatchObject({
      title: 'API key',
      secrets: ['K'],
      serverSecrets: [],
      schemes: ['api_key'],
    })
    expect(o[1]?.oauth).toMatchObject({ flow: 'implicit' })
    // a client id and secret are the server's; the bearer built from the session is nobody's to type
    expect(o[2]).toMatchObject({ secrets: [], serverSecrets: ['CID', 'CS'] })
    expect(o[2]?.oauth).toBeUndefined()
  })

  it('has nothing for a service with no auth, or an unknown one', () => {
    expect(
      authOptions({ ...cfg, services: { s: { spec: '', baseUrl: 'x' } } } as never, 's'),
    ).toEqual([])
    expect(authOptions(cfg, 'nope')).toEqual([])
  })

  it('uses the rendered sign-in settings the caller gives for an environment', () => {
    const rendered = {
      authorizationUrl: 'https://sandbox.test/authorize',
      flow: 'implicit' as const,
    }
    expect(authOptions(cfg, 'pets', (p) => (p === 'tok' ? rendered : undefined))[1]?.oauth).toEqual(
      rendered,
    )
  })
})

describe('which profiles an operation uses', () => {
  const wantsKey: SecurityRequirement[] = [{ api_key: [] }]
  const wantsOauth: SecurityRequirement[] = [{ petstore_auth: ['read'] }]
  const either: SecurityRequirement[] = [{ api_key: [] }, { petstore_auth: ['read'] }]

  it('puts the person’s choice first and leaves the rest as listed', () => {
    expect(ordered(listed, 'tok')).toEqual(['tok', 'key', 'cc'])
    expect(ordered(listed, 'gone')).toEqual(listed)
    expect(ordered(listed)).toEqual(listed)
  })

  it('lets a person choose among the profiles every operation accepts', () => {
    expect(choosable(listed, auth, [either])).toEqual(['key', 'tok', 'cc'])
    expect(choosable(listed, auth, [wantsKey])).toEqual(['key'])
    expect(choosable(listed, auth, [wantsOauth])).toEqual(['tok', 'cc'])
    // a flow with an operation of each: no one profile serves both
    expect(choosable(listed, auth, [wantsKey, wantsOauth])).toEqual([])
    // an operation that needs nothing takes no part
    expect(choosable(listed, auth, [wantsKey, false])).toEqual(['key'])
  })

  it('uses the choice when the operation accepts it, and the first it does accept when not', () => {
    expect(neededProfiles(listed, auth, [either], 'tok')).toEqual(['tok'])
    expect(neededProfiles(listed, auth, [either])).toEqual(['key'])
    expect(neededProfiles(listed, auth, [wantsOauth], 'key')).toEqual(['tok'])
  })

  it('needs one profile per kind of operation in a flow, and none for an open one', () => {
    expect(neededProfiles(listed, auth, [wantsKey, wantsOauth])).toEqual(['key', 'tok'])
    expect(neededProfiles(listed, auth, [false])).toEqual([])
    expect(neededProfiles(listed, auth, [undefined])).toEqual(['key'])
  })

  it('names the schemes the spec wants that no listed profile supplies', () => {
    expect(unservedSchemes(listed, auth, [[{ other: [] }]])).toEqual(['other'])
    expect(unservedSchemes(listed, auth, [either, true, undefined])).toEqual([])
  })
})

describe('availability', () => {
  const [key, tok, cc] = authOptions(cfg, 'pets') as [
    ReturnType<typeof authOptions>[number],
    ReturnType<typeof authOptions>[number],
    ReturnType<typeof authOptions>[number],
  ]
  const none = () => false
  const all = () => true

  it('is ready when the page holds every secret, or asks for the way the person gives it', () => {
    expect(availability(key, all, none, true)).toBe('ready')
    expect(availability(key, none, none, true)).toBe('paste')
    expect(availability(tok, none, none, true)).toBe('sign-in')
    expect(availability(tok, all, none, true)).toBe('ready')
  })

  it('leaves a server-side profile to the server, and is unavailable where there is none', () => {
    expect(availability(cc, none, all, true)).toBe('ready')
    expect(availability(cc, all, none, true)).toBe('server-missing')
    // what the page holds is not the server's to use
    expect(availability(cc, all, all, false)).toBe('unavailable')
  })
})
