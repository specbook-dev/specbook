import { describe, expect, it } from 'vitest'
import { badgeHref, showBadge } from '../src/badge'

describe('Powered by Specbook', () => {
  it('shows on a published site, and not for the dev server', () => {
    expect(showBadge({ host: 'docs.acme.com', published: true })).toBe(true)
    expect(showBadge({ host: 'localhost', published: false })).toBe(false)
  })

  it('can be turned off, and is never shown on specbook.dev itself', () => {
    expect(showBadge({ host: 'docs.acme.com', published: true, badge: false })).toBe(false)
    expect(showBadge({ host: 'ui.specbook.dev', published: true })).toBe(false)
    expect(showBadge({ host: 'specbook.dev', published: true })).toBe(false)
    // a host that merely contains the name is not ours
    expect(showBadge({ host: 'notspecbook.dev', published: true })).toBe(true)
  })

  it('links back with the host as the only referral', () => {
    expect(badgeHref('docs.acme.com')).toBe('https://ui.specbook.dev/?ref=docs.acme.com')
    expect(badgeHref('a b')).toBe('https://ui.specbook.dev/?ref=a%20b')
  })
})
