import { describe, expect, it } from 'vitest'
import { toSnippet } from '../src/snippets'

const base = {
  method: 'POST',
  url: 'https://api.example.com/repos/octocat/hello/issues',
  headers: { Authorization: 'Bearer {{secrets.GITHUB_TOKEN}}' },
  body: { title: "It's broken", labels: ['bug'] },
}

describe('cURL', () => {
  it('sends JSON with the secret as an env variable', () => {
    expect(toSnippet('curl', { ...base, encoding: 'json' })).toBe(
      [
        "curl 'https://api.example.com/repos/octocat/hello/issues' \\",
        '  -H "Authorization: Bearer ${GITHUB_TOKEN}" \\',
        "  -H 'Content-Type: application/json' \\",
        `  -d '{"title":"It'\\''s broken","labels":["bug"]}'`,
      ].join('\n'),
    )
  })

  it('leaves out the method when it is the default and adds it otherwise', () => {
    expect(toSnippet('curl', { method: 'GET', url: 'https://x.test/a', query: { q: 'a b' } })).toBe(
      "curl 'https://x.test/a?q=a%20b'",
    )
    expect(toSnippet('curl', { method: 'DELETE', url: 'https://x.test/a/1' })).toBe(
      "curl 'https://x.test/a/1' \\\n  -X DELETE",
    )
    expect(toSnippet('curl', { method: 'PUT', url: 'https://x.test/a', body: { a: 1 } })).toContain(
      '-X PUT',
    )
  })

  it('repeats array query parameters', () => {
    expect(
      toSnippet('curl', { method: 'GET', url: 'https://x.test', query: { s: ['a', 'b'] } }),
    ).toBe("curl 'https://x.test?s=a&s=b'")
  })

  it('writes forms as url-encoded fields with bracket keys', () => {
    const out = toSnippet('curl', {
      method: 'POST',
      url: 'https://x.test/customers',
      encoding: 'form',
      body: { email: 'a@b.c', metadata: { order: '1' } },
    })
    expect(out).toContain("--data-urlencode 'email=a@b.c'")
    expect(out).toContain("--data-urlencode 'metadata[order]=1'")
  })

  it('writes multipart parts and files', () => {
    const file = new File(['x'], 'cat.png', { type: 'image/png' })
    const out = toSnippet('curl', {
      method: 'POST',
      url: 'https://x.test/up',
      encoding: 'multipart',
      body: { note: 'hi', file },
    })
    expect(out).toContain("-F 'note=hi'")
    expect(out).toContain("-F 'file=@cat.png'")
  })

  it('posts a graphql query as JSON', () => {
    const out = toSnippet('curl', {
      method: 'POST',
      url: 'https://x.test/graphql',
      encoding: 'graphql',
      body: { query: '{ countries { code } }' },
    })
    expect(out).toContain('-d \'{"query":"{ countries { code } }"}\'')
    expect(out).toContain('Content-Type: application/json')
  })
})

describe('recorded requests', () => {
  it('names session values and keeps file stand-ins as files', () => {
    const input = {
      method: 'POST',
      url: 'https://x.test/up',
      headers: { Authorization: 'Bearer {{session.token}}' },
      encoding: 'multipart' as const,
      body: { file: { file: 'cat.png', type: 'image/png', size: 3 } },
    }
    const c = toSnippet('curl', input)
    expect(c).toContain('Bearer ${SESSION_TOKEN}')
    expect(c).toContain("-F 'file=@cat.png'")
    expect(toSnippet('fetch', input)).toContain('process.env.SESSION_TOKEN')
  })
})

describe('Node fetch', () => {
  it('sends JSON with the secret from process.env', () => {
    expect(toSnippet('fetch', { ...base, encoding: 'json' })).toBe(
      [
        "const res = await fetch('https://api.example.com/repos/octocat/hello/issues', {",
        "  method: 'POST',",
        '  headers: {',
        '    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,',
        "    'Content-Type': 'application/json',",
        '  },',
        '  body: JSON.stringify({',
        "    title: 'It\\'s broken',",
        '    labels: [',
        "      'bug',",
        '    ],',
        '  }),',
        '})',
        'console.log(res.status, await res.text())',
      ].join('\n'),
    )
  })

  it('omits options for a plain GET', () => {
    expect(
      toSnippet('fetch', { method: 'GET', url: 'https://x.test/a', query: { q: 'x y' } }),
    ).toBe(
      [
        "const res = await fetch('https://x.test/a?q=x%20y')",
        'console.log(res.status, await res.text())',
      ].join('\n'),
    )
  })

  it('uses URLSearchParams for forms and keeps repeated keys', () => {
    const out = toSnippet('fetch', {
      method: 'POST',
      url: 'https://x.test/f',
      encoding: 'form',
      formArrays: 'repeat',
      body: { tag: ['a', 'b'] },
    })
    expect(out).toContain('new URLSearchParams([')
    expect(out).toContain("'application/x-www-form-urlencoded'")
  })

  it('builds FormData and reads files with openAsBlob', () => {
    const file = new File(['x'], 'cat.png', { type: 'image/png' })
    const out = toSnippet('fetch', {
      method: 'POST',
      url: 'https://x.test/up',
      encoding: 'multipart',
      body: { note: 'hi', file },
    })
    expect(out.startsWith("import { openAsBlob } from 'node:fs'")).toBe(true)
    expect(out).toContain("form.append('note', 'hi')")
    expect(out).toContain("form.append('file', await openAsBlob('cat.png'), 'cat.png')")
    expect(out).toContain('body: form,')
  })

  it('produces code that parses', () => {
    const src = toSnippet('fetch', { ...base, encoding: 'json' })
    const AsyncFn = Object.getPrototypeOf(async () => {}).constructor as new (s: string) => unknown
    expect(() => new AsyncFn(src)).not.toThrow()
  })
})
