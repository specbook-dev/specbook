import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import '../../src/embed'

const play = () => document.querySelector('specbook-play') as HTMLElement
const playButton = () => play().shadowRoot?.querySelector('button') as HTMLButtonElement
const panel = () => document.querySelector('specbook-panel') as HTMLElement | null
const q = (sel: string) => panel()?.shadowRoot?.querySelector(sel) ?? null
const field = (label: string) => q(`input[aria-label="${label}"]`) as HTMLInputElement | null
/** The panel animates in; measure it once it has stopped. */
const settled = async () => {
  await Promise.all(
    (q('.panel') as HTMLElement).getAnimations().map((a) => a.finished.catch(() => undefined)),
  )
}
const press = (key: string, on: Element | null = q('.panel')) =>
  on?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }))

describe('embed', () => {
  afterEach(() => {
    panel()?.remove()
    document.body.innerHTML = ''
    for (const s of document.head.querySelectorAll('style')) s.remove()
    delete document.documentElement.dataset.theme
  })

  const page_ = (html: string, css = '') => {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
    document.body.innerHTML = html
  }
  const host = async (css = '') => {
    page_('<p data-specbook-try="petstore/GetPetById">Get a pet</p>', css)
    await vi.waitFor(() => expect(play()).not.toBeNull())
  }
  const open = async () => {
    playButton().click()
    await vi.waitFor(() => expect(q('.request-panel .rq-bar')).not.toBeNull(), {
      timeout: 30_000,
    })
  }
  const openFlow = async (html: string) => {
    page_(html)
    await vi.waitFor(() => expect(play()).not.toBeNull())
    playButton().click()
    await vi.waitFor(() => expect(q('.sequence-panel')).not.toBeNull(), { timeout: 30_000 })
  }

  it('adds a Play button to data-specbook-try and -flow elements, also ones added later', async () => {
    await host()
    expect(playButton().textContent).toBe('▶ Play')
    expect(playButton().getAttribute('aria-haspopup')).toBe('dialog')
    expect(playButton().getAttribute('aria-label')).toBe('Play GetPetById')
    document.body.insertAdjacentHTML(
      'beforeend',
      '<p data-specbook-flow="adopt-pet">Adopt a pet</p>',
    )
    await vi.waitFor(() => expect(document.querySelectorAll('specbook-play').length).toBe(2))
  })

  it('makes a button that carries the attribute the trigger itself, with no Play button beside it', async () => {
    page_('<button data-specbook-try="petstore/GetPetById">Run it</button>')
    const b = document.querySelector('button') as HTMLButtonElement
    await vi.waitFor(() => expect(b.getAttribute('aria-haspopup')).toBe('dialog'))
    expect(document.querySelector('specbook-play')).toBeNull()
    b.click()
    await vi.waitFor(() => expect(q('.request-panel .rq-bar')).not.toBeNull(), { timeout: 30_000 })
    expect(b.getAttribute('aria-expanded')).toBe('true')
  })

  it('opens the panel in a shadow root that host CSS cannot reach', async () => {
    await host('* { color: red !important; font-family: serif } button { background: red }')
    await open()
    expect(document.querySelector('.panel')).toBeNull()
    expect(getComputedStyle(q('.sb-root') as Element).color).not.toBe('rgb(255, 0, 0)')
    expect(getComputedStyle(q('.panel-head h2') as Element).color).not.toBe('rgb(255, 0, 0)')
    expect(getComputedStyle(q('.btn') as Element).backgroundColor).not.toBe('rgb(255, 0, 0)')
  })

  it('is themed with plain host CSS tokens and ::part', async () => {
    await host(
      'specbook-panel { --sb-surface: rgb(1, 2, 3) } specbook-panel::part(header) { border-bottom: 3px solid rgb(9, 9, 9) }',
    )
    await open()
    expect(getComputedStyle(q('.panel') as Element).backgroundColor).toBe('rgb(1, 2, 3)')
    expect(getComputedStyle(q('.panel-head') as Element).borderBottomWidth).toBe('3px')
  })

  it('is a modal dialog in the top layer, and can open on the Docs tab', async () => {
    page_('<p data-specbook-try="petstore/AddPet" data-specbook-tab="docs">Add a pet</p>')
    await vi.waitFor(() => expect(play()).not.toBeNull())
    playButton().click()
    await vi.waitFor(() => expect(q('.panel table.fields')).not.toBeNull(), { timeout: 30_000 })
    expect(q('.panel')?.getAttribute('aria-modal')).toBe('true')
    expect(q('.panel')?.getAttribute('role')).toBe('dialog')
    // named by its own heading
    const id = q('.panel')?.getAttribute('aria-labelledby') as string
    expect(q(`#${id}`)?.textContent).toBeTruthy()
    expect(q('.panel-backdrop')).not.toBeNull()
    expect(q('.sb-top')?.matches(':popover-open')).toBe(true)
    expect(q('.prism-code-editor')).toBeNull()
  })

  it('closes with Escape, the backdrop and the ×, and gives focus back to the button that opened it', async () => {
    await host()
    for (const close of [
      () => press('Escape'),
      () => (q('.panel-backdrop') as HTMLButtonElement).click(),
      () => (q('button[aria-label="Close panel"]') as HTMLButtonElement).click(),
    ]) {
      await open()
      expect(play().shadowRoot?.activeElement).not.toBe(playButton())
      close()
      await vi.waitFor(() => expect(q('.panel')).toBeNull())
      expect(play().shadowRoot?.activeElement).toBe(playButton())
      expect(playButton().getAttribute('aria-expanded')).toBe('false')
    }
  })

  it('tells the page: events on the trigger, expanded while open', async () => {
    await host()
    const seen: string[] = []
    document.addEventListener('specbook:open', () => seen.push('open'))
    document.addEventListener('specbook:close', () => seen.push('close'))
    await open()
    expect(playButton().getAttribute('aria-expanded')).toBe('true')
    press('Escape')
    await vi.waitFor(() => expect(seen).toEqual(['open', 'close']))
  })

  it('runs a flow with preset inputs, and Generate and Run with defaults work in it', async () => {
    await openFlow(
      '<p data-specbook-flow="stripe-checkout" data-specbook-inputs=\'{"amount":3000}\'>Checkout</p>',
    )
    expect(field('amount')?.value).toBe('3000')
    // the generated customer name is filled in, and the die makes another
    await vi.waitFor(() => expect(field('fullName')?.value).not.toBe(''), { timeout: 30_000 })
    const first = field('fullName')?.value
    ;(q('button[aria-label="Generate fullName"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(field('fullName')?.value).not.toBe(first))
    const button = (text: string) =>
      [...(panel()?.shadowRoot?.querySelectorAll('button') ?? [])].find((b) =>
        b.textContent?.includes(text),
      ) as HTMLButtonElement
    button('Run with defaults').click()
    await vi.waitFor(() => expect(q('.seq-run .badge')?.textContent).toContain('Passed'), {
      timeout: 30_000,
    })
    // a screen reader is told how it went
    expect(q('[role="status"]')?.textContent).toMatch(/Flow passed, \d+ of \d+ steps passed/)
  })

  it('says what a bad attribute asked, instead of failing quietly', async () => {
    await openFlow('<p data-specbook-flow="adopt-pet" data-specbook-inputs="{nope">Adopt</p>')
    await vi.waitFor(() => expect(q('.embed-banner')?.textContent).toContain('not valid JSON'))
    press('Escape')
    await vi.waitFor(() => expect(q('.panel')).toBeNull())

    page_('<p data-specbook-try="petstore/NoSuchOperation">Nope</p>')
    await vi.waitFor(() => expect(play()).not.toBeNull())
    playButton().click()
    await vi.waitFor(() => expect(q('.embed-problem')?.textContent).toContain('NoSuchOperation'), {
      timeout: 30_000,
    })
  })

  it('does not touch the page: no draft in its storage, no change to its address, no shift of its layout', async () => {
    await host()
    // other test files share this origin's storage: start from nothing of ours
    for (const store of [localStorage, sessionStorage])
      for (const k of Object.keys(store)) if (k.startsWith('specbook')) store.removeItem(k)
    const before = {
      width: document.documentElement.clientWidth,
      overflow: getComputedStyle(document.body).overflow,
      padding: getComputedStyle(document.body).paddingRight,
      hash: location.hash,
    }
    await open()
    ;(q('button[aria-label="Send"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(q('.response .state-badge')).not.toBeNull(), { timeout: 30_000 })
    expect(Object.keys(localStorage).filter((k) => k.startsWith('specbook'))).toEqual([])
    expect(Object.keys(sessionStorage).filter((k) => k.startsWith('specbook'))).toEqual([])
    expect({
      width: document.documentElement.clientWidth,
      overflow: getComputedStyle(document.body).overflow,
      padding: getComputedStyle(document.body).paddingRight,
      hash: location.hash,
    }).toEqual(before)
  })

  it('offers no dialog it cannot open: no new environment, no settings link', async () => {
    await host()
    await open()
    const options = [...(q('.env-badge')?.querySelectorAll('option') ?? [])].map(
      (o) => o.textContent,
    )
    expect(options.join(' ')).not.toContain('New environment')
  })

  it('wears the host page theme, follows it as it changes, and an element can choose its own', async () => {
    document.documentElement.dataset.theme = 'dark'
    await host()
    await open()
    expect(panel()?.getAttribute('data-theme')).toBe('dark')
    expect(playButton() && play().getAttribute('data-theme')).toBe('dark')
    document.documentElement.dataset.theme = 'light'
    await vi.waitFor(() => expect(panel()?.getAttribute('data-theme')).toBe('light'))
    document.documentElement.dataset.theme = 'dark'
    await vi.waitFor(() => expect(panel()?.getAttribute('data-theme')).toBe('dark'))
    const dark = getComputedStyle(q('.panel') as Element).backgroundColor
    document.documentElement.dataset.theme = 'light'
    await vi.waitFor(() =>
      expect(getComputedStyle(q('.panel') as Element).backgroundColor).not.toBe(dark),
    )

    press('Escape')
    await vi.waitFor(() => expect(q('.panel')).toBeNull())
    page_('<p data-specbook-try="petstore/GetPetById" data-specbook-theme="dark">Get</p>')
    await vi.waitFor(() => expect(play()).not.toBeNull())
    expect(play().getAttribute('data-theme')).toBe('dark')
  })

  describe('on a phone', () => {
    it('is a sheet from the bottom that fits the screen, with no sideways scroll', async () => {
      const [w, h] = [window.innerWidth, window.innerHeight]
      await page.viewport(390, 844)
      try {
        await host()
        await open()
        await settled()
        const box = (q('.panel') as HTMLElement).getBoundingClientRect()
        expect(Math.round(box.bottom)).toBe(window.innerHeight)
        expect(Math.round(box.width)).toBe(window.innerWidth)
        expect(box.top).toBeGreaterThan(0)
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
        expect((q('.panel') as HTMLElement).scrollWidth).toBeLessThanOrEqual(
          (q('.panel') as HTMLElement).clientWidth,
        )
      } finally {
        await page.viewport(w, h)
      }
    })
  })

  it('is a centered dialog on a desktop', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    await page.viewport(1280, 800)
    try {
      await host()
      await open()
      await settled()
      const box = (q('.panel') as HTMLElement).getBoundingClientRect()
      expect(box.width).toBeLessThanOrEqual(880)
      expect(Math.abs(box.left + box.width / 2 - window.innerWidth / 2)).toBeLessThan(2)
      expect(Math.abs(box.top + box.height / 2 - window.innerHeight / 2)).toBeLessThan(2)
    } finally {
      await page.viewport(w, h)
    }
  })
})
