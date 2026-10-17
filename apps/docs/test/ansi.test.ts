import { createColors } from '@specbook/core'
import { describe, expect, it } from 'vitest'
import { ansiToHtml } from '../src/lib/ansi'

describe('ansiToHtml', () => {
  it('knows every code core can emit', () => {
    const c = createColors(true)
    for (const name of ['red', 'green', 'yellow', 'cyan', 'dim', 'bold'] as const) {
      const html = ansiToHtml(c[name]('x'))
      expect(html, name).toMatch(/^<span class="a-[a-z]+">x<\/span>$/)
      expect(html).not.toContain('\u001b')
    }
  })

  it('escapes text and leaves plain text alone', () => {
    expect(ansiToHtml('a <b> & c')).toBe('a &lt;b&gt; &amp; c')
  })

  it('nests and closes in order', () => {
    const c = createColors(true)
    expect(ansiToHtml(c.bold(`${c.green('✓')} ok`))).toBe(
      '<span class="a-b"><span class="a-green">✓</span> ok</span>',
    )
  })

  it('refuses a code it does not know, so a new one is noticed', () => {
    expect(() => ansiToHtml('\u001b[35mx\u001b[39m')).toThrow(/35/)
  })
})
