import { describe, expect, it } from 'vitest'
import { brandCss, onAccent } from '../src/branding'

describe('branding', () => {
  it('chooses readable text for an accent', () => {
    expect(onAccent('#6d28d9')).toBe('#ffffff')
    expect(onAccent('#a78bfa')).toBe('#0b1020')
    expect(onAccent('#238636')).toBe('#ffffff')
    expect(onAccent('#fde047')).toBe('#0b1020')
    expect(onAccent('#fff')).toBe('#0b1020')
    expect(onAccent('rebeccapurple')).toBeUndefined()
  })

  it('writes accent tokens, with a separate dark value only when given', () => {
    expect(brandCss({})).toBe('')
    const light = brandCss({ accent: '#238636' })
    expect(light).toContain('--sb-accent:#238636')
    expect(light).toContain('--sb-text-on-accent:#ffffff')
    expect(light).not.toContain('prefers-color-scheme')
    const both = brandCss({ accent: '#238636', accentDark: '#3fb950' })
    expect(both).toContain('@media (prefers-color-scheme: dark)')
    expect(both).toContain('--sb-accent:#3fb950')
    expect(both).toContain(':root[data-theme="dark"]')
  })
})
