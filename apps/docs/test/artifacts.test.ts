import { describe, expect, it } from 'vitest'
import { headersFile, inlineScriptHashes } from '../integrations/artifacts.mjs'

describe('the headers the site is served with', () => {
  it('allows exactly the inline scripts the build produced, found by reading them back', () => {
    const html = `<script>window.a = 1</script><script src="/x.js"></script><script type="module">import 'y'</script><script>  </script>`
    const hashes = inlineScriptHashes(html)
    expect(hashes).toHaveLength(2)
    expect(hashes.every((h: string) => /^'sha256-[A-Za-z0-9+/]+=*'$/.test(h))).toBe(true)
    // the same script on two pages is allowed once
    expect(new Set(inlineScriptHashes(html + html)).size).toBe(2)
  })

  it('is strict for the pages and open only where an app calls other origins', () => {
    const text = headersFile(["'sha256-abc='"])
    const pages = text.slice(0, text.indexOf('/viewer/*'))
    expect(pages).toContain("script-src 'self' 'sha256-abc='")
    expect(pages).toContain("connect-src 'self'")
    expect(pages).not.toMatch(/script-src[^;]*unsafe-inline/)
    expect(pages).not.toMatch(/style-src 'self' 'unsafe-inline'/)
    expect(pages).toContain("style-src-attr 'unsafe-inline'")
    for (const app of ['/viewer/*', '/demo/*', '/qa/*']) {
      const rule = text.slice(text.indexOf(`${app}\n`))
      expect(rule.slice(0, rule.indexOf('\n\n'))).toContain('! Content-Security-Policy')
      expect(rule.slice(0, rule.indexOf('\n\n'))).toContain('connect-src *')
    }
  })

  it('never lets the worker or the entry scripts go stale, and hashed files live forever', () => {
    const text = headersFile([])
    expect(text).toMatch(/\/sw\.js\n\s+Cache-Control: no-cache/)
    expect(text).toMatch(/\/qa\/specbook\.js\n\s+Cache-Control: no-cache/)
    expect(text).toMatch(/\/_astro\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/)
    expect(text).toMatch(/\/downloads\/\*[\s\S]*Content-Disposition: attachment/)
  })
})
