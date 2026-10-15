import { describe, expect, it } from 'vitest'
import { rawGithub } from '../src/viewer/share'

describe('rawGithub', () => {
  const raw = 'https://raw.githubusercontent.com/acme/shop/main/docs/openapi.yaml'

  it('turns a file page and its Raw link into the document address', () => {
    expect(rawGithub('https://github.com/acme/shop/blob/main/docs/openapi.yaml')).toBe(raw)
    expect(rawGithub('https://github.com/acme/shop/raw/main/docs/openapi.yaml')).toBe(raw)
    expect(rawGithub('https://www.github.com/acme/shop/blob/main/docs/openapi.yaml')).toBe(raw)
  })

  it('drops the query and fragment a file page carries', () => {
    expect(rawGithub('https://github.com/acme/shop/blob/main/docs/openapi.yaml?plain=1#L10')).toBe(
      raw,
    )
  })

  it('keeps a branch name with slashes in the path', () => {
    expect(rawGithub('https://github.com/acme/shop/blob/feature/x/openapi.json')).toBe(
      'https://raw.githubusercontent.com/acme/shop/feature/x/openapi.json',
    )
  })

  it('leaves every other address alone', () => {
    for (const a of [
      raw,
      'https://example.com/blob/main/openapi.json',
      'https://github.com/acme/shop',
      'https://github.com/acme/shop/issues/1',
      'https://gist.github.com/acme/abc123',
      'http://github.com/acme/shop/blob/main/openapi.json',
      'not an address',
    ])
      expect(rawGithub(a)).toBe(a)
  })
})
