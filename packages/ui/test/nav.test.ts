import { describe, expect, it } from 'vitest'
import { hashFor, parseHash, setDefaultService } from '../src/nav'
import { shareLinks, softEncode } from '../src/viewer/share'

describe('links', () => {
  it('leave the service out when there is only one, and still open the long form', () => {
    setDefaultService('swagger-petstore')
    expect(hashFor({ kind: 'op', key: 'swagger-petstore/FindPetsByStatus' })).toBe(
      '#/op/FindPetsByStatus',
    )
    expect(parseHash('#/op/FindPetsByStatus')).toMatchObject({
      kind: 'op',
      key: 'swagger-petstore/FindPetsByStatus',
    })
    // an older, fully qualified link
    expect(parseHash('#/op/swagger-petstore%2FFindPetsByStatus')).toMatchObject({
      key: 'swagger-petstore/FindPetsByStatus',
    })
    expect(hashFor({ kind: 'op', key: 'swagger-petstore/Get', tab: 'docs' })).toBe(
      '#/op/Get?tab=docs',
    )
  })

  it('keep the service when there are several APIs', () => {
    setDefaultService(undefined)
    expect(hashFor({ kind: 'op', key: 'github/ReposGet' })).toBe('#/op/github/ReposGet')
    expect(parseHash('#/op/github/ReposGet')).toMatchObject({ key: 'github/ReposGet' })
  })

  it('show the spec address as it is, escaping only what would break the link', () => {
    expect(softEncode('https://petstore3.swagger.io/api/v3/openapi.json')).toBe(
      'https://petstore3.swagger.io/api/v3/openapi.json',
    )
    expect(softEncode('https://x.io/a b?v=1&w=2#frag')).toBe(
      'https://x.io/a%20b%3Fv%3D1%26w%3D2%23frag',
    )
    const { link } = shareLinks(
      { origin: 'https://ui.specbook.dev', pathname: '/v1/', hash: '#/op/FindPetsByStatus' },
      'https://petstore3.swagger.io/api/v3/openapi.json',
      'Petstore',
    )
    expect(link).toBe(
      'https://ui.specbook.dev/v1/?spec=https://petstore3.swagger.io/api/v3/openapi.json#/op/FindPetsByStatus',
    )
  })
})

describe('a host that is not the app', () => {
  it('takes links itself instead of writing the page address', async () => {
    const { go, setNavigator, route } = await import('../src/nav')
    const before = route.value
    const seen: unknown[] = []
    setNavigator((r) => seen.push(r))
    go({ kind: 'op', key: 'petstore/GetPetById' })
    setNavigator(undefined)
    expect(seen).toEqual([{ kind: 'op', key: 'petstore/GetPetById' }])
    expect(route.value).toBe(before)
  })
})
