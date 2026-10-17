import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/app'
import { catalogFilter, catalogService, go, paletteOpen, route } from '../../src/nav'
import { env } from '../../src/store'
import 'prism-code-editor/layout.css'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'
import '../../src/styles/panel.css'

describe('requests are listed beside flows', () => {
  let root: HTMLElement
  beforeEach(() => {
    localStorage.clear()
    catalogService.value = ''
    catalogFilter.value = ''
    env.value = 'mock'
    go({ kind: 'home' })
    root = document.createElement('div')
    document.body.append(root)
  })
  afterEach(() => {
    render(null, root)
    document.body.innerHTML = ''
    paletteOpen.value = false
  })

  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T | null
  const waitFor = (fn: () => void) => vi.waitFor(fn, { timeout: 20_000 })
  const mount = async () => {
    render(<App />, root)
    await waitFor(() => expect(root.querySelectorAll('.req-row').length).toBeGreaterThan(3))
  }
  const row = (title: string) =>
    [...root.querySelectorAll<HTMLElement>('.req-row')].find((r) => r.textContent?.includes(title))

  it('lists each saved request with its method, path and tags, apart from the operations', async () => {
    await mount()
    const section = $('section.requests') as HTMLElement
    expect(section.getAttribute('aria-label')).toBe('Requests')
    const find = row('Find pets by status') as HTMLElement
    expect(find.querySelector('.method')?.textContent).toBe('GET')
    expect(find.querySelector('.op-path')?.textContent).toBe('/pet/findByStatus')
    expect(find.querySelector('.req-tag')?.textContent).toBe('smoke')
    // the operation is still in its own group, and is not the request (a crowded catalog starts collapsed)
    catalogService.value = 'petstore'
    await waitFor(() =>
      expect(root.querySelectorAll('.op-row:not(.req-row):not(.flow-row)').length).toBeGreaterThan(
        10,
      ),
    )
  })

  it('opens the operation on that request, with its values shown and not editable', async () => {
    await mount()
    ;(row('Find pets by status') as HTMLElement).click()
    await waitFor(() => expect($('.request-panel .rq-bar')).not.toBeNull())
    const r = route.value
    expect(r.kind === 'op' && r.play?.startsWith('saved:')).toBe(true)
    // the picker is on the saved request, and its row is the active one
    await waitFor(() => {
      const sel = $<HTMLSelectElement>('.request-panel select')
      expect(sel?.selectedOptions[0]?.textContent).toContain('· request')
    })
    expect(row('Find pets by status')?.classList.contains('active')).toBe(true)
    catalogService.value = 'petstore'
    await waitFor(() => expect(root.querySelector('.op-group')).not.toBeNull())
    // its operation row is quiet while one of its requests is open
    const opRow = [
      ...root.querySelectorAll<HTMLElement>('.op-row:not(.req-row):not(.flow-row)'),
    ].find((x) => x.textContent?.includes('Finds Pets by status'))
    expect(opRow?.classList.contains('active')).toBe(false)
    await waitFor(() => {
      const cells = [
        ...root.querySelectorAll<HTMLInputElement>(
          '.request-panel .tab-pane:first-of-type .grid input.cell',
        ),
      ]
      expect(cells.length).toBeGreaterThan(0)
      expect(cells.every((c) => c.readOnly)).toBe(true)
    })
    // no row to add, and the variables a run asks for are still the person's to fill in
    expect($('.request-panel .tab-pane:first-of-type .grid tr.ghost')).toBeNull()
  })

  it('finds a request by its tag in the filter and in the palette, and labels it a request', async () => {
    await mount()
    catalogFilter.value = 'smoke'
    await waitFor(() => expect(root.querySelectorAll('.req-row').length).toBe(2))
    expect(row('Get an order')).toBeDefined()
    catalogFilter.value = ''
    paletteOpen.value = true
    await waitFor(() => expect(document.querySelector('.palette input')).not.toBeNull())
    const input = document.querySelector('.palette input') as HTMLInputElement
    input.value = 'Find pets by status'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await waitFor(() => {
      const kinds = [...document.querySelectorAll('.palette li button .muted')].map(
        (m) => m.textContent,
      )
      expect(kinds).toContain('Request')
    })
  })

  it('has no Requests section when nothing matches the filter', async () => {
    await mount()
    catalogFilter.value = 'zzzz-no-such-thing'
    await waitFor(() => expect($('section.requests')).toBeNull())
  })
})
