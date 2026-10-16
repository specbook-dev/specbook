import { render } from 'preact'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { App } from '../../src/app'
import { go } from '../../src/nav'
import { env } from '../../src/store'
import 'prism-code-editor/layout.css'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'
import '../../src/styles/panel.css'

describe('a dropdown cell on a phone', () => {
  let root: HTMLElement
  afterEach(() => {
    render(null, root)
    document.body.innerHTML = ''
    env.value = 'mock'
  })

  it('opens its list under the field without the pane scrolling away', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    await page.viewport(390, 844)
    try {
      env.value = 'mock'
      root = document.createElement('div')
      document.body.append(root)
      render(<App />, root)
      await vi.waitFor(
        () => expect(root.querySelectorAll('.pills .pill').length).toBeGreaterThan(2),
        {
          timeout: 15_000,
        },
      )
      go({ kind: 'op', key: 'petstore/FindPetsByStatus', play: 'default' })
      await vi.waitFor(
        () => expect(root.querySelector('.request-panel .combo input')).not.toBeNull(),
        {
          timeout: 30_000,
        },
      )
      const pane = root.querySelector('.request-panel .tab-pane') as HTMLElement
      const input = root.querySelector('.request-panel .combo input') as HTMLElement
      const before = input.getBoundingClientRect().top

      // the text, not the chevron
      await userEvent.click(input)
      await vi.waitFor(() => expect(root.querySelector('.combo-list')).not.toBeNull())
      // the keyboard's room is made after a moment, and the field is placed again as it settles
      await new Promise((r) => setTimeout(r, 900))
      expect(pane.scrollTop).toBe(0)
      // and no scrollbar appears for room it does not need
      expect(pane.scrollHeight).toBeLessThanOrEqual(pane.clientHeight)
      expect(input.getBoundingClientRect().top).toBeCloseTo(before, 0)
      const list = root.querySelector('.combo-list') as HTMLElement
      expect(list.getBoundingClientRect().top - input.getBoundingClientRect().bottom).toBeLessThan(
        8,
      )
    } finally {
      await page.viewport(w, h)
    }
  })
})
