import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { App } from '../../src/app'
import { brand } from '../../src/branding'
import { listWidth } from '../../src/components/ListResizer'
import { catalogFilter, catalogService, go, paletteOpen } from '../../src/nav'
import { env, environmentRisk, seed } from '../../src/store'
import { theme } from '../../src/theme'
import 'prism-code-editor/autocomplete-icons.css'
import 'prism-code-editor/autocomplete.css'
import 'prism-code-editor/layout.css'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'
import '../../src/styles/panel.css'

describe('docs and play panel', () => {
  let root: HTMLElement
  beforeEach(() => {
    localStorage.clear()
    catalogService.value = ''
    listWidth.value = undefined
    seed.value = undefined
    env.value = 'mock'
    theme.value = 'auto'
    delete document.documentElement.dataset.theme
    catalogFilter.value = ''
    go({ kind: 'home' })
    root = document.createElement('div')
    document.body.append(root)
  })
  afterEach(() => {
    render(null, root)
    document.body.innerHTML = ''
    paletteOpen.value = false
  })

  const mount = async () => {
    render(<App />, root)
    await vi.waitFor(
      () => expect(root.querySelectorAll('.pills .pill').length).toBeGreaterThan(2),
      {
        timeout: 15_000,
      },
    )
  }
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T | null
  const button = (text: string, within: ParentNode = root) => {
    const b = [...within.querySelectorAll('button')].find((x) => x.textContent?.trim() === text)
    if (!b) throw new Error(`button "${text}" not found`)
    return b as HTMLButtonElement
  }
  const type = (el: HTMLInputElement | HTMLSelectElement, v: string, ev = 'input') => {
    el.value = v
    el.dispatchEvent(new Event(ev, { bubbles: true }))
  }
  const editor = () => $<HTMLTextAreaElement>('.request-panel .body textarea')
  /** Open the panel on an operation and wait until its request has loaded. */
  const play = async (key: string, example = '') => {
    go({ kind: 'op', key, play: example })
    await vi.waitFor(() => expect($('.request-panel .rq-bar')).not.toBeNull(), {
      timeout: 30_000,
    })
    await vi.waitFor(() => expect($('.request-panel select')).not.toBeNull())
  }
  const send = async () => {
    // the button stays disabled until the example (and any sample file) has loaded
    const sendButton = () => $<HTMLButtonElement>('button[aria-label="Send"]') as HTMLButtonElement
    await vi.waitFor(() => expect(sendButton().disabled).toBe(false), { timeout: 15_000 })
    sendButton().click()
    await vi.waitFor(() => expect($('.response .state-badge')).not.toBeNull(), { timeout: 15_000 })
  }
  const waitFor = (fn: () => void) => vi.waitFor(fn, { timeout: 15_000 })

  it('is a list of APIs and flows, and ⌘K jumps straight into the panel', async () => {
    await mount()
    expect(root.querySelectorAll('.flow-row').length).toBe(4)
    // flows are one section with a single FLOW badge; ungrouped ones are under Default (no sub-heading)
    expect($('.flows .flows-title .method.flow')?.textContent).toBe('FLOW')
    expect(root.querySelectorAll('.flows .method.flow').length).toBe(1)
    expect($('.panel')).toBeNull()

    // the list renders before effects (and the palette's key listener) have run, so retry until it opens
    await vi.waitFor(() => {
      if (!document.querySelector('.palette'))
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }),
        )
      expect(document.querySelector('.palette')).not.toBeNull()
    })
    const input = document.querySelector('.palette input') as HTMLInputElement
    type(input, 'adopt a pet')
    await vi.waitFor(() =>
      expect(document.querySelector('.palette li')?.textContent).toContain('Adopt a pet'),
    )
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    // the sequence module is imported on demand
    await waitFor(() => expect($('.panel-head h2')?.textContent).toBe('Adopt a pet'))
  })

  it('drills into an API with pills and opens an operation docked beside the list', async () => {
    await mount()
    const pill = [...root.querySelectorAll<HTMLButtonElement>('.pills .pill')].find((p) =>
      p.textContent?.startsWith('petstore'),
    )
    pill?.click()
    await waitFor(() => expect(root.querySelectorAll('.op-row:not(.flow-row)').length).toBe(19))
    expect($('.op-row:not(.flow-row) .method')?.textContent).toMatch(/GET|POST|PUT|DELETE|PATCH/)

    const row = [...root.querySelectorAll<HTMLButtonElement>('.op-row:not(.flow-row)')].find((r) =>
      r.textContent?.includes('Find pet by ID'),
    )
    row?.click()
    await vi.waitFor(() => expect($('.panel-head h2')?.textContent).toBe('Find pet by ID'), {
      timeout: 30_000,
    })
    // docked: the page is not dimmed and the list is still there to pick another operation
    expect($('.panel-backdrop')).toBeNull()
    expect(root.querySelectorAll('.op-row:not(.flow-row)').length).toBe(19)
    expect($('.op-row.active')?.textContent).toContain('Find pet by ID')
  })

  it('shows the response as soon as a request has been sent, and the request is one click away', async () => {
    await mount()
    await play('petstore/FindPetsByStatus')
    const on = () => $('.request-panel .rq-tab.on')?.textContent?.trim() ?? ''
    // before sending, the tab is the request's own (its parameters)
    expect(on()).not.toMatch(/^Response/)
    await send()
    await waitFor(() => expect(on()).toMatch(/^Response/))
    expect($('.response .state-badge')).not.toBeNull()

    // going back to the request does not lose the response, and sending again returns to it
    const tab = (label: string) =>
      [...root.querySelectorAll<HTMLButtonElement>('.request-panel .rq-tab')].find((t) =>
        t.textContent?.trim().startsWith(label),
      )
    tab('Params')?.click()
    await waitFor(() => expect(on()).toMatch(/^Params/))
    await send()
    await waitFor(() => expect(on()).toMatch(/^Response/))
  })

  it('offers a copyable cURL and Node fetch sample on the Request tab', async () => {
    await mount()
    await play('petstore/AddPet')
    const tab = [...root.querySelectorAll<HTMLButtonElement>('.request-panel .rq-tab')].find((t) =>
      t.textContent?.startsWith('Request'),
    )
    tab?.click()
    await waitFor(() => expect($('.code-block')?.textContent).toContain('curl '))
    expect($('.code-block')?.textContent).toContain('/pet')
    expect($('.code-block')?.textContent).toContain("-d '")
    button('Node fetch').click()
    await waitFor(() => expect($('.code-block')?.textContent).toContain('await fetch('))
    expect($('.code-block')?.textContent).toContain("method: 'POST'")
  })

  it('shows the markdown that sits beside a saved request, in Try and on the Docs tab', async () => {
    await mount()
    await play('petstore/FindPetsByStatus')
    // saved requests load after the first screen, so the option can arrive after the panel does
    const saved = 'saved:requests/petstore/find-pets.req.ts'
    await waitFor(() =>
      expect($(`.request-panel .rq-meta select option[value="${saved}"]`)).not.toBeNull(),
    )
    const select = $<HTMLSelectElement>('.request-panel .rq-meta select') as HTMLSelectElement
    type(select, saved, 'change')
    await waitFor(() => expect($('.request-panel .step-about')?.textContent).toContain('available'))
    go({ kind: 'op', key: 'petstore/FindPetsByStatus', tab: 'docs' })
    await waitFor(() => expect($('.saved-note-doc')?.textContent).toContain('Find pets by status'))
    expect($('.saved-note-doc')?.textContent).toContain('quickest way to find a')
  })

  it('adds the project page and field notes to the spec tables on the Docs tab', async () => {
    await mount()
    go({ kind: 'op', key: 'petstore/AddPet', tab: 'docs' })
    await waitFor(() =>
      expect($('.doc-project')?.textContent).toContain('registers it in the store'),
    )
    // and a field note sits in the field's row
    await waitFor(() => expect($('.field-note')?.textContent).toContain('under 40 characters'))
  })

  it('is usable at phone width: a settings menu and a full-width panel without sideways scrolling', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    await page.viewport(390, 844)
    try {
      await mount()
      const shown = (el: Element | null) => !!el && getComputedStyle(el).display !== 'none'
      expect(shown($('.menu-btn'))).toBe(true)
      // the header's controls are behind the menu button until it is pressed
      expect(shown($('.header-controls'))).toBe(false)
      ;($('.menu-btn') as HTMLButtonElement).click()
      await waitFor(() => expect(shown($('.header-controls'))).toBe(true))
      expect($('.header-controls')?.textContent).toContain('Environment')

      // opening an operation closes the menu and gives the panel the whole width
      go({ kind: 'op', key: 'petstore/AddPet', play: 'default' })
      await vi.waitFor(() => expect($('.request-panel .rq-bar')).not.toBeNull(), {
        timeout: 30_000,
      })
      expect(shown($('.header-controls'))).toBe(false)
      const panel = $('.panel') as HTMLElement
      expect(panel.getBoundingClientRect().width).toBeGreaterThan(window.innerWidth - 2)
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
    } finally {
      await page.viewport(w, h)
    }
  })

  it('keeps the phone header inside the screen however long the product name is', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    await page.viewport(360, 800)
    const before = brand.value
    // earlier tests leave the loaded branding behind; start unloaded so `ready` really means this mount's
    brand.value = { links: [], ready: false }
    try {
      await mount()
      // the project's own branding arrives after mount and would replace a name set earlier
      await waitFor(() => expect(brand.value.ready).toBe(true))
      brand.value = { ...brand.value, name: 'Acme Payments Platform Developer Portal' }
      await waitFor(() => expect($('.brand-name')?.textContent).toContain('Acme'))
      const menu = $('.menu-btn') as HTMLElement
      expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth)
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
    } finally {
      brand.value = before
      await page.viewport(w, h)
    }
  })

  it('puts a focused parameter cell near the top of its pane on a phone, clear of the keyboard', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    await page.viewport(390, 844)
    try {
      await mount()
      go({ kind: 'op', key: 'petstore/FindPetsByStatus', play: 'default' })
      const cells = () => [
        ...document.querySelectorAll<HTMLInputElement>('.tab-pane:not([hidden]) input.cell'),
      ]
      await vi.waitFor(() => expect(cells().length).toBeGreaterThan(0), { timeout: 30_000 })
      const cell = cells()[cells().length - 1] as HTMLInputElement
      const pane = cell.closest('.tab-pane') as HTMLElement
      cell.focus()
      // the pane is given room under its content so the cell can rise above the keyboard
      await waitFor(() => expect(getComputedStyle(pane).paddingBottom).not.toBe('0px'))
      await waitFor(() => {
        const above = cell.getBoundingClientRect().top - pane.getBoundingClientRect().top
        expect(above).toBeLessThan(pane.clientHeight * 0.4)
      })
    } finally {
      await page.viewport(w, h)
    }
  })

  it('keeps the docs inside the panel on a phone: a long path wraps and nothing widens the page', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    await page.viewport(390, 844)
    try {
      await mount()
      go({
        kind: 'op',
        key: 'github/ActionsSetActionsCacheRetentionLimitForEnterprise',
        tab: 'docs',
      })
      await vi.waitFor(() => expect($('.doc-intro')).not.toBeNull(), { timeout: 30_000 })
      const panel = $('.panel') as HTMLElement
      const intro = $('.doc-intro') as HTMLElement
      const room = panel.getBoundingClientRect().right
      expect(intro.getBoundingClientRect().right).toBeLessThanOrEqual(room)
      const code = intro.querySelector('code') as HTMLElement
      expect(code.getBoundingClientRect().right).toBeLessThanOrEqual(
        intro.getBoundingClientRect().right,
      )
      const doc = $('.doc') as HTMLElement
      expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth)
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
    } finally {
      await page.viewport(w, h)
    }
  })

  it('lines "Respond with" up under Example on a phone, filling the row', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    await page.viewport(390, 844)
    try {
      await mount()
      go({ kind: 'op', key: 'petstore/AddPet', play: 'default' })
      await waitFor(() => expect($('.request-panel .rq-status select')).not.toBeNull())
      const example = $('.request-panel .rq-example select') as HTMLElement
      const respond = $('.request-panel .rq-status select') as HTMLElement
      const [e, r] = [example.getBoundingClientRect(), respond.getBoundingClientRect()]
      // a second row, not squeezed onto the first, and not stranded at the right
      expect(r.top).toBeGreaterThan(e.bottom - 2)
      expect(Math.abs(r.left - e.left)).toBeLessThanOrEqual(2)
      expect(r.right).toBeLessThanOrEqual(window.innerWidth)
      expect(r.width).toBeGreaterThan(120)
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
    } finally {
      await page.viewport(w, h)
    }
  })

  it('keeps the phone panel header to one row, and names the environment beside Example', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    await page.viewport(390, 844)
    try {
      await mount()
      go({
        kind: 'op',
        key: 'github/ActionsSetActionsCacheRetentionLimitForEnterprise',
        play: 'default',
      })
      await vi.waitFor(() => expect($('.request-panel .rq-bar')).not.toBeNull(), {
        timeout: 30_000,
      })
      // a long title, the stepper and close share one row instead of stacking
      const head = $('.panel-head') as HTMLElement
      const title = $('.panel-head .panel-title') as HTMLElement
      const close = $('button[aria-label="Close panel"]') as HTMLElement
      expect(close.getBoundingClientRect().top).toBeLessThan(title.getBoundingClientRect().bottom)
      expect(close.getBoundingClientRect().right).toBeLessThanOrEqual(390)
      expect(head.getBoundingClientRect().height).toBeLessThan(96)

      // Example and the environment share a line, in mock too (where "Respond with" also lives)
      const sameLine = () => {
        const sel = $('.request-panel .rq-example select') as HTMLElement
        expect(
          Math.abs(sel.getBoundingClientRect().top - badge().getBoundingClientRect().top),
        ).toBeLessThan(24)
        expect(sel.getBoundingClientRect().width).toBeGreaterThan(80)
      }
      await waitFor(() => expect($('.request-panel .rq-example select')).not.toBeNull())

      // the environment, beside Example, since the header is under the panel
      const badge = () => $('.request-panel .rq-meta .env-badge') as HTMLElement
      const label = () => badge()?.querySelector('.env-name')?.textContent?.replace(/\s*▾$/, '')
      await waitFor(() => expect(label()).toBe('mock'))
      sameLine()
      expect(badge().classList.contains('live')).toBe(false)
      env.value = 'live'
      await waitFor(() => expect(label()).toBe('live'))
      expect(badge().classList.contains('live')).toBe(true)
      sameLine()
      env.value = 'production'
      await waitFor(() => expect(badge()?.classList.contains('prod')).toBe(true))
      // the config can say what is production (or not), whatever the name
      env.value = 'live'
      environmentRisk.value = { live: 'production' }
      await waitFor(() => expect(badge()?.classList.contains('prod')).toBe(true))
      env.value = 'production'
      environmentRisk.value = { production: 'sandbox' }
      await waitFor(() => expect(badge()?.classList.contains('prod')).toBe(false))
      expect(badge().classList.contains('live')).toBe(true)
      environmentRisk.value = {}
      env.value = 'mock'

      // it is also the way to switch: choosing in its picker changes the environment
      const picker = badge().querySelector('select') as HTMLSelectElement
      expect([...picker.options].map((o) => o.value)).toEqual(
        expect.arrayContaining(['mock', 'live']),
      )
      picker.value = 'live'
      picker.dispatchEvent(new Event('change', { bubbles: true }))
      await waitFor(() => expect(env.value).toBe('live'))
      // and the picker is at least 16px, so iOS does not zoom when it opens
      expect(parseFloat(getComputedStyle(picker).fontSize)).toBeGreaterThanOrEqual(16)

      // the header carries the same chip, so the environment is visible (and switchable) without the menu
      ;($('button[aria-label="Close panel"]') as HTMLButtonElement).click()
      await waitFor(() => expect($('.panel')).toBeNull())
      const header = $('.header .header-env .env-badge') as HTMLElement
      expect(getComputedStyle(header.parentElement as HTMLElement).display).not.toBe('none')
      expect(header.querySelector('.env-name')?.textContent).toContain('live')
    } finally {
      env.value = 'mock'
      await page.viewport(w, h)
    }
  })

  it('opens on the overview as a splash on a phone, and the list comes after Browse', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    await page.viewport(390, 844)
    try {
      await mount()
      expect($('.layout')?.getAttribute('data-view')).toBe('splash')
      expect(getComputedStyle($('.list-col') as HTMLElement).display).toBe('none')
      ;($('.overview-browse') as HTMLButtonElement).click()
      await waitFor(() => expect($('.layout')?.getAttribute('data-view')).toBe('list'))
      expect(location.hash).toBe('#/browse')
      expect(getComputedStyle($('.list-col') as HTMLElement).display).not.toBe('none')
      // closing a panel returns to the list, not back to the splash
      go({ kind: 'op', key: 'petstore/AddPet', tab: 'docs' })
      await vi.waitFor(() => expect($('.panel')).not.toBeNull(), { timeout: 30_000 })
      ;($('button[aria-label="Close panel"]') as HTMLButtonElement).click()
      await waitFor(() => expect(location.hash).toBe('#/browse'))
    } finally {
      await page.viewport(w, h)
    }
  })

  it('shows a tapped step as a sheet from the bottom on a phone, and lets you hide it', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    await page.viewport(390, 844)
    try {
      await mount()
      go({ kind: 'seq', id: 'github-triage', play: '' })
      await vi.waitFor(() => expect($('.controls-grid')).not.toBeNull(), { timeout: 30_000 })
      button('▶ Run', $('.sequence-panel') as HTMLElement).click()
      await vi.waitFor(
        () => expect(root.querySelectorAll('.jstep.pass').length).toBeGreaterThan(0),
        {
          timeout: 20_000,
        },
      )
      // nothing covers the timeline until a step is tapped
      expect($('.seq-right')?.classList.contains('sheet-open')).toBe(false)
      expect(getComputedStyle($('.seq-right') as HTMLElement).display).toBe('none')
      // a step can be opened once the run has finished: until then its head is disabled, though the
      // step already shows as passed, so waiting for "passed" alone raced the end of the run
      await vi.waitFor(() => expect(root.querySelector('.jhead:not([disabled])')).not.toBeNull(), {
        timeout: 30_000,
      })
      ;(root.querySelector('.jhead:not([disabled])') as HTMLButtonElement).click()
      await waitFor(() => expect($('.seq-right')?.classList.contains('sheet-open')).toBe(true))
      const rect = ($('.seq-right') as HTMLElement).getBoundingClientRect()
      expect(rect.bottom).toBeGreaterThan(window.innerHeight - 2)
      expect($('.step-exchange')).not.toBeNull()
      ;($('.sheet-close') as HTMLButtonElement).click()
      await waitFor(() => expect($('.seq-right')?.classList.contains('sheet-open')).toBe(false))
    } finally {
      await page.viewport(w, h)
    }
  })

  it('steps to the next operation from the panel', async () => {
    await mount()
    await play('petstore/FindPetsByStatus')
    const title = () => $('.panel-head h2')?.textContent
    expect(title()).toBe('Finds Pets by status')
    ;($('button[aria-label="Next"]') as HTMLButtonElement).click()
    await waitFor(() => expect(title()).toBe('Finds Pets by tags'))
  })

  it('shows the spec tables on the Docs tab, with no editor until Try', async () => {
    await mount()
    go({ kind: 'op', key: 'petstore/AddPet', tab: 'docs' })
    await waitFor(() => {
      const table = $('.panel table.fields')?.textContent ?? ''
      expect(table).toContain('photoUrls')
      expect(table).toContain('pet status in the store')
    })
    expect($('.prism-code-editor')).toBeNull()
    button('Try it').click()
    await vi.waitFor(() => expect($('.request-panel .rq-bar')).not.toBeNull(), { timeout: 30_000 })
  })

  it('plays a generated example and checks the response against the spec', async () => {
    await mount()
    await play('petstore/GetPetById')
    await waitFor(() => expect($('.request-panel .grid')?.textContent).toContain('petId'))
    await send()
    expect($('.response .sent')?.textContent).toMatch(/\/pet\/\d+/)
    expect($('.response .state-badge')?.textContent).toMatch(/200/)
    await waitFor(() => expect($('.response .conf')?.textContent).toContain('Matches spec'))
  })

  it('lists spec, generated and dynamic examples and switches between them', async () => {
    await mount()
    await play('petstore/AddPet')
    const select = $<HTMLSelectElement>('.request-panel select') as HTMLSelectElement
    const names = [...select.options].map((o) => o.value)
    expect(names).toEqual(expect.arrayContaining(['ex:default', 'ex:dynamic']))

    type(select, 'ex:default', 'change')
    await waitFor(() => expect(editor()?.value).toContain('"doggie"'))
    type(select, 'ex:dynamic', 'change')
    await waitFor(() => expect(editor()?.value).toContain('{{faker.'))
    await send()
    expect($('.response .state-badge')?.textContent).toMatch(/200/)
    const body = $('.response .body-editor textarea') as HTMLTextAreaElement
    expect(body.value).not.toContain('{{faker')
  })

  it('keeps the field documentation on screen, docked to the bottom of the pane, in a short window', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    try {
      for (const [vw, vh] of [
        [1158, 650],
        [390, 600],
      ] as const) {
        await page.viewport(vw, vh)
        await mount()
        await play('github/ActionsSetActionsCacheRetentionLimitForEnterprise', 'default')
        await waitFor(() => expect(editor()?.value).toContain('{'))
        await waitFor(() => expect($('.request-panel .field-doc')).not.toBeNull())
        const bodyTab = [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')].find((b) =>
          b.textContent?.startsWith('Body'),
        )
        bodyTab?.click()
        await waitFor(async () => {
          const ta = editor() as HTMLTextAreaElement
          ta.focus()
          ta.setSelectionRange(5, 5)
          document.dispatchEvent(new Event('selectionchange'))
          expect($('.request-panel .field-doc')?.textContent).toContain('max_cache_retention_days')
        })
        const doc = $('.request-panel .field-doc') as HTMLElement
        const pane = doc.closest('.tab-pane') as HTMLElement
        const box = doc.getBoundingClientRect()
        // inside the pane that scrolls it, and inside the window
        expect(box.height).toBeGreaterThan(0)
        expect(box.bottom).toBeLessThanOrEqual(pane.getBoundingClientRect().bottom + 1)
        expect(box.bottom).toBeLessThanOrEqual(window.innerHeight)
      }
    } finally {
      await page.viewport(w, h)
    }
  })

  it('lays the operation docs out once: the page below the header appears all at once', async () => {
    await mount()
    const frames: string[] = []
    const seen = new MutationObserver(() => {
      const doc = document.querySelector('.doc')
      if (!doc) return
      const parts = [
        doc.querySelector('.doc-custom') ? 'text' : '',
        doc.querySelector('table.fields') ? 'fields' : '',
        doc.querySelector('.statuses') ? 'statuses' : '',
      ].join('+')
      if (frames[frames.length - 1] !== parts) frames.push(parts)
    })
    seen.observe(document.body, { childList: true, subtree: true })
    try {
      go({
        kind: 'op',
        key: 'github/ActionsSetActionsCacheRetentionLimitForEnterprise',
        tab: 'docs',
      })
      await vi.waitFor(() => expect($('.doc table.fields')).not.toBeNull(), { timeout: 30_000 })
      await new Promise((r) => setTimeout(r, 200))
    } finally {
      seen.disconnect()
    }
    // the header alone, then everything: never the page growing in steps
    expect(frames.filter((f) => f !== '++')).toEqual(['text+fields+statuses'])
  })

  it('shows field documentation in the body as sent, as it does in the editor and the response', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    // a short window, where the description would otherwise sit below the fold
    await page.viewport(1158, 560)
    await mount()
    await play('petstore/AddPet', 'default')
    await waitFor(() => expect(editor()?.value).toContain('"status"'))
    await send()
    await waitFor(() => expect($('.response .state-badge')?.textContent).toMatch(/200/))
    // the request tab, then its "Sent" view
    ;[...document.querySelectorAll<HTMLButtonElement>('.request-panel [role=tab]')]
      .find((b) => b.textContent?.startsWith('Request'))
      ?.click()
    await waitFor(() => expect(button('Sent', $('.request-panel') as HTMLElement)).toBeTruthy())
    button('Sent', $('.request-panel') as HTMLElement).click()
    await waitFor(() => expect($('.request-panel .sent-view .body-editor textarea')).not.toBeNull())
    await waitFor(() => {
      const ta = $('.request-panel .sent-view .body-editor textarea') as HTMLTextAreaElement
      const at = ta.value.indexOf('"status"')
      ta.focus()
      ta.setSelectionRange(at + 2, at + 2)
      document.dispatchEvent(new Event('selectionchange'))
      expect($('.request-panel .sent-view .field-doc')?.textContent).toContain(
        'pet status in the store',
      )
    })
    const doc = $('.request-panel .sent-view .field-doc') as HTMLElement
    const pane = doc.closest('.tab-pane') as HTMLElement
    expect(doc.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      pane.getBoundingClientRect().bottom + 1,
    )
    await page.viewport(w, h)
  })

  it('shows the documentation of the field the cursor is on, below the editor', async () => {
    await mount()
    await play('petstore/AddPet', 'default')
    await waitFor(() => expect(editor()?.value).toContain('"status"'))
    // docs load asynchronously with the schemas
    await waitFor(async () => {
      const ta = editor() as HTMLTextAreaElement
      const at = ta.value.indexOf('"status"')
      ta.focus()
      ta.setSelectionRange(at + 2, at + 2)
      document.dispatchEvent(new Event('selectionchange'))
      expect($('.request-panel .field-doc')?.textContent).toContain('pet status in the store')
    })
    expect($('.request-panel .field-doc code')?.textContent).toBe('status')
    // no per-line comments inside the editor
    expect($('.request-panel .body-editor')?.textContent).not.toMatch(/\/\/ /)
  })

  it('lets a repeated query key be switched off before sending', async () => {
    await mount()
    await play('petstore/FindPetsByTags')
    await waitFor(() => expect($('.request-panel .grid')?.textContent).toContain('tags'))
    const row = () =>
      [...root.querySelectorAll('.request-panel .grid tr')].find((r) =>
        r.querySelector('.g-key')?.textContent?.startsWith('tags'),
      ) as HTMLElement
    const value = row().querySelector('.g-val input') as HTMLInputElement
    type(value, 'cute')
    await waitFor(() =>
      expect((row().querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(true),
    )
    await send()
    expect($('.response .sent')?.textContent).toContain('tags=cute')

    ;(row().querySelector('input[type=checkbox]') as HTMLInputElement).click()
    await waitFor(() => expect($('.request-panel .grid tr.off')).not.toBeNull())
    await send()
    await waitFor(() => expect($('.response .sent')?.textContent).not.toContain('tags='))
  })

  it('lists examples the team added next to the generated ones', async () => {
    await mount()
    await play('stripe/PostCustomers')
    const select = $<HTMLSelectElement>('.request-panel select') as HTMLSelectElement
    const mine = [...select.options].find((o) => o.value === 'ex:acme-vip')
    expect(mine?.textContent).toContain('yours')
    type(select, 'ex:acme-vip', 'change')
    await waitFor(() => expect(editor()?.value).toContain('"tier": "vip"'))
    await send()
    expect($('.response .state-badge')?.textContent).toMatch(/200/)
  })

  it('shows a markdown page written for an operation instead of the spec text', async () => {
    await mount()
    go({ kind: 'op', key: 'petstore/AddPet', tab: 'docs' })
    await waitFor(() =>
      expect($('.doc-custom')?.textContent).toContain('registers it in the store'),
    )
    expect($('.doc-custom strong')?.textContent).toBe('name')
  })

  it('keeps edits per example, with a reset', async () => {
    await mount()
    await play('petstore/AddPet', 'default')
    await waitFor(() => expect(editor()?.value).toContain('doggie'))
    const ta = editor() as HTMLTextAreaElement
    type(ta as unknown as HTMLInputElement, ta.value.replace('doggie', 'rex'))
    await waitFor(() => expect(button('↺ Reset')).toBeDefined())
    button('↺ Reset').click()
    await waitFor(() => expect(editor()?.value).toContain('doggie'))
  })

  it('asks for a value nothing supplies, right under the URL, and sends once it is given', async () => {
    await mount()
    await play('petstore/AddPet', 'default')
    await waitFor(() => expect(editor()?.value).toContain('doggie'))
    expect($('.needs-vars')).toBeNull()
    const ta = editor() as HTMLTextAreaElement
    type(ta as unknown as HTMLInputElement, ta.value.replace('"doggie"', '"{{nickname}}"'))
    await waitFor(() => expect($('.needs-vars')?.textContent).toContain('nickname'))
    const input = $<HTMLInputElement>('.needs-vars input') as HTMLInputElement
    expect($('.needs-vars')?.classList.contains('ok')).toBe(false)
    type(input, 'R')
    await new Promise((r) => setTimeout(r, 60))
    // the field is still there to keep typing in, and now reads as satisfied
    expect($('.needs-vars input')).toBe(input)
    type(input, 'Rex')
    await new Promise((r) => setTimeout(r, 60))
    await waitFor(() => expect($('.needs-vars')?.classList.contains('ok')).toBe(true))
    await send()
    expect($('.response')?.textContent).toContain('200')
  })

  it('shows saved requests read-only', async () => {
    await mount()
    await play('petstore/AddPet', 'default')
    const select = $<HTMLSelectElement>('.request-panel select') as HTMLSelectElement
    await waitFor(() =>
      expect([...select.options].some((o) => o.value.startsWith('saved:'))).toBe(true),
    )
    const saved = [...select.options].find((o) => o.value.startsWith('saved:')) as HTMLOptionElement
    type(select, saved.value, 'change')
    await waitFor(() => expect($('.lock')).not.toBeNull())
    expect(editor()?.value).toContain('{{petId}}')
  })

  it('edits a form body as nested JSON and can switch to the bracket-key grid and back', async () => {
    await mount()
    await play('stripe/PostCustomers', 'acme-vip')
    // JSON is the default view, so nested objects stay nested
    await waitFor(() => expect(editor()?.value).toContain('"metadata"'))
    await send()
    expect($('.response .state-badge')?.textContent).toMatch(/200/)

    button('Grid').click()
    await waitFor(() => {
      const keys = [...root.querySelectorAll<HTMLInputElement>('.request-panel .g-key input')].map(
        (i) => i.value,
      )
      expect(keys).toContain('metadata[tier]')
    })
    button('JSON').click()
    await waitFor(() => expect(editor()?.value).toContain('"tier": "vip"'))
  })

  it('suggests keys from the schema while typing in a JSON body', async () => {
    await mount()
    await play('petstore/AddPet', 'default')
    await waitFor(() => expect(editor()?.value).toContain('doggie'))
    const ta = editor() as HTMLTextAreaElement
    // an object with just an opening quote where a key goes, then Ctrl+Space
    ta.focus()
    type(ta as unknown as HTMLInputElement, '{\n  "')
    ta.setSelectionRange(ta.value.length, ta.value.length)
    ta.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, bubbles: true }),
    )
    await waitFor(() => {
      const tip = $('.pce-ac-tooltip')?.textContent ?? ''
      expect(tip).toContain('photoUrls')
      expect(tip).toContain('category')
    })
  })

  it('plays an upload from the example folder with no setup', async () => {
    await mount()
    await play('petstore/UploadFile')
    await send()
    expect($('.response .state-badge')?.textContent).toMatch(/200/)
  })

  it('runs a sequence: timeline on the left, the chosen step on the right', async () => {
    await mount()
    go({ kind: 'seq', id: 'adopt-pet', play: '' })
    await vi.waitFor(() => expect($('.sequence-panel .journey')).not.toBeNull(), {
      timeout: 30_000,
    })
    expect(root.querySelectorAll('.jstep').length).toBe(4)

    button('▶ Run', $('.sequence-panel') as HTMLElement).click()
    await vi.waitFor(() => expect($('.pause')).not.toBeNull(), { timeout: 15_000 })
    // the offered pets are in the choice's select, shown as its current value
    expect($<HTMLInputElement>('.pause input[role=combobox]')?.value).toContain('doggie')
    button('Continue ▶').click()

    await vi.waitFor(() => expect(root.querySelectorAll('.jstep.pass').length).toBe(4), {
      timeout: 15_000,
    })
    const uses = [...root.querySelectorAll('.cap.use')].map((c) => c.textContent)
    expect(uses.some((t) => t?.includes('orderId'))).toBe(true)

    ;(root.querySelectorAll('.jhead')[2] as HTMLButtonElement).click()
    await waitFor(() => expect($('.seq-right')?.textContent).toContain('/store/order'))
  })

  it('lays a step out like an operation: bar, Request and Response tabs, checked against the schema', async () => {
    await mount()
    go({ kind: 'seq', id: 'adopt-pet', play: '' })
    await vi.waitFor(() => expect($('.sequence-panel .journey')).not.toBeNull(), {
      timeout: 30_000,
    })
    button('▶ Run', $('.sequence-panel') as HTMLElement).click()
    await vi.waitFor(() => expect($('.pause')).not.toBeNull(), { timeout: 15_000 })
    button('Continue ▶').click()
    await vi.waitFor(() => expect(root.querySelectorAll('.jstep.pass').length).toBe(4), {
      timeout: 15_000,
    })

    ;(root.querySelectorAll('.jhead')[2] as HTMLButtonElement).click()
    await waitFor(() => expect($('.step-exchange .rq-bar .method')?.textContent).toBe('POST'))
    expect($('.step-exchange .rq-bar code')?.textContent).toContain('/store/order')
    expect($('.step-exchange .result-chip')?.textContent).toMatch(/200/)
    const tabs = [...root.querySelectorAll('.step-exchange .rq-tab')].map((t) => t.textContent)
    expect(tabs.join(' ')).toMatch(/Request\s+Response/)
    // the response is validated against the operation's schema, as in an operation's own panel
    await waitFor(() => expect($('.step-exchange .conf')?.textContent).toContain('Matches spec'))
    // and the request tab shows what was sent
    ;(
      [...root.querySelectorAll<HTMLButtonElement>('.step-exchange .rq-tab')].find((t) =>
        t.textContent?.startsWith('Request'),
      ) as HTMLButtonElement
    ).click()
    // as a copyable sample first, with the request as sent one click away
    await waitFor(() => expect($('.step-exchange .code-block')?.textContent).toContain('curl '))
    button('Sent', $('.step-exchange') as HTMLElement).click()
    await waitFor(() => expect($('.step-exchange .sent-view')?.textContent).toContain('petId'))
  })

  it('edits sequence controls in the same grid as request parameters', async () => {
    await mount()
    go({ kind: 'seq', id: 'adopt-pet', play: '' })
    await vi.waitFor(() => expect($('.controls-grid')).not.toBeNull(), { timeout: 30_000 })
    expect($('.controls-grid')?.classList.contains('grid')).toBe(true)
    expect($('.controls-grid tbody .g-key')?.textContent).toContain('quantity')
    expect($('.controls-grid tbody .g-doc')?.textContent).toContain('How many of the chosen pet')

    const input = $<HTMLInputElement>('.controls-grid input[type=number]') as HTMLInputElement
    type(input, '3')
    // let the new value render, as a person's click would come after
    await new Promise((r) => setTimeout(r, 60))
    button('▶ Run', $('.sequence-panel') as HTMLElement).click()
    await vi.waitFor(() => expect($('.pause')).not.toBeNull(), { timeout: 15_000 })
    // the choice an input step asks for uses the same grid
    expect($('.pause .controls-grid')).not.toBeNull()
    button('Continue ▶').click()
    await vi.waitFor(() => expect(root.querySelectorAll('.jstep.pass').length).toBe(4), {
      timeout: 15_000,
    })
    ;(root.querySelectorAll('.jhead')[2] as HTMLButtonElement).click()
    await waitFor(() => expect($('.step-exchange')?.textContent).toContain('/store/order'))
    ;(
      [...root.querySelectorAll<HTMLButtonElement>('.step-exchange .rq-tab')].find((t) =>
        t.textContent?.startsWith('Request'),
      ) as HTMLButtonElement
    ).click()
    await waitFor(() =>
      expect($('.step-exchange .code-block')?.textContent).toContain('"quantity":3'),
    )
    button('Node fetch', $('.step-exchange') as HTMLElement).click()
    await waitFor(() =>
      expect($('.step-exchange .code-block')?.textContent).toContain('quantity: 3'),
    )
    button('Sent', $('.step-exchange') as HTMLElement).click()
    await waitFor(() =>
      expect($('.step-exchange .sent-view')?.textContent).toContain('"quantity": 3'),
    )
  })

  it('documents a sequence: markdown page, controls and the operation behind each step, no Run button', async () => {
    await mount()
    go({ kind: 'seq', id: 'adopt-pet', tab: 'docs' })
    await waitFor(() => expect($('.panel .doc-custom')).not.toBeNull())
    // the markdown page for the sequence (docs/adopt-pet.md) is rendered
    await waitFor(() => expect($('.doc-custom strong')?.textContent).toBe('adoption'))
    expect($('.doc-custom ol')?.querySelectorAll('li').length).toBe(4)
    // `## Place order` names a step: its section sits under that step, not in the intro
    expect($('.doc-custom')?.textContent).not.toContain('should match the pet')
    await waitFor(() =>
      expect($('.step-note-row')?.textContent).toContain('which the next step verifies'),
    )
    expect($('.doc-custom a')?.getAttribute('href')).toContain('petstore3.swagger.io')
    // controls and steps are tables, steps name their operation
    const tables = [...root.querySelectorAll('.panel table.fields')].map((t) => t.textContent)
    expect(tables.join(' ')).toContain('quantity')
    expect(tables.join(' ')).toContain('/pet/findByStatus')
    expect(tables.join(' ')).toContain('/store/order')
    // there is no second Run button on the docs page
    expect(
      [...root.querySelectorAll('.panel article button')].some((b) =>
        b.textContent?.includes('Run'),
      ),
    ).toBe(false)
  })

  it('closes the panel with Escape and keeps the page', async () => {
    await mount()
    await play('petstore/GetPetById')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.waitFor(() => expect($('.panel')).toBeNull())
    expect($('.catalog')).not.toBeNull()
  })

  it('edits a GraphQL body as a query and variables, and sends both', async () => {
    await mount()
    await play('countries/Query', 'country')
    const area = (label: string) => $<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)
    await waitFor(() => expect(area('GraphQL query')?.value).toContain('country(code: $code)'))
    expect(JSON.parse(area('GraphQL variables')?.value ?? '')).toEqual({ code: 'DE' })

    const vars = area('GraphQL variables') as HTMLTextAreaElement
    vars.value = '{ "code": "NO" }'
    vars.dispatchEvent(new Event('input', { bubbles: true }))
    await send()
    const sent = $('.response .sent')?.textContent ?? ''
    expect(sent).toContain('POST')
    await waitFor(() => {
      const body = $('.response .body-editor textarea') as HTMLTextAreaElement
      expect(body.value).toContain('"country"')
    })
  })

  it('repeats a query key as its own rows, each with a checkbox, and shows the resulting URL', async () => {
    await mount()
    await play('petstore/FindPetsByStatus')
    await waitFor(() => expect($('.request-panel .grid')?.textContent).toContain('status'))
    const url = () => $('.rq-url code')?.textContent ?? ''
    expect(url()).toContain('/pet/findByStatus?status=available')

    const repeat = () => $<HTMLButtonElement>('button[aria-label="Repeat status"]')?.click()
    repeat()
    await waitFor(() => expect(url()).toContain('status=available&status=pending'))
    expect(root.querySelectorAll('.request-panel .grid tbody tr input[type=checkbox]').length).toBe(
      2,
    )

    // the new row's checkbox switches just that value off
    const boxes = () => [
      ...root.querySelectorAll<HTMLInputElement>(
        '.request-panel .grid tbody tr input[type=checkbox]',
      ),
    ]
    boxes()[1]?.click()
    await waitFor(() => expect(url()).toMatch(/\?status=available$/))

    // typing in the empty last row adds a new key
    const ghost = $<HTMLInputElement>('.request-panel .grid tr.ghost input')
    type(ghost as HTMLInputElement, 'limit')
    await waitFor(() =>
      expect(root.querySelectorAll('.request-panel .grid tbody tr').length).toBe(4),
    )
    await send()
    expect($('.response .sent')?.textContent).toContain('status=available')
  })

  it('lets the list column be resized, remembers it, and resets on double-click', async () => {
    await mount()
    // the test viewport is narrow (single column), so check the state the layout is driven by
    const handle = $<HTMLElement>('.list-resizer') as HTMLElement
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await waitFor(() => expect(listWidth.value).toBeGreaterThanOrEqual(280))
    const grown = listWidth.value
    expect(localStorage.getItem('specbook:list-width')).toBe(String(grown))
    expect($('.app')?.getAttribute('style')).toContain(`--sb-list-w: ${grown}px`)

    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await waitFor(() => expect(listWidth.value).toBeUndefined())
    expect(localStorage.getItem('specbook:list-width')).toBeNull()
  })

  it('keeps a group open after you open one of its operations', async () => {
    await mount()
    ;[...root.querySelectorAll<HTMLButtonElement>('.pills .pill')]
      .find((p) => p.textContent?.startsWith('github'))
      ?.click()
    const head = () =>
      [...root.querySelectorAll<HTMLButtonElement>('.group-head')].find((h) =>
        h.textContent?.includes('actions'),
      ) as HTMLButtonElement
    await waitFor(() => expect(head().getAttribute('aria-expanded')).toBe('false'))
    head().click()
    await waitFor(() => expect(head().getAttribute('aria-expanded')).toBe('true'))
    ;($('.op-row:not(.flow-row)') as HTMLButtonElement).click()
    await vi.waitFor(() => expect($('.panel-head h2')).not.toBeNull(), { timeout: 30_000 })
    expect(head().getAttribute('aria-expanded')).toBe('true')
  })

  it('lets grid columns be resized and remembers the widths', async () => {
    await mount()
    await play('petstore/FindPetsByStatus')
    await waitFor(() => expect($('.request-panel .grid')).not.toBeNull())
    const keyCol = () => $<HTMLElement>('.request-panel .grid col:nth-child(2)') as HTMLElement
    const before = Number.parseFloat(keyCol().style.width)

    const handle = $<HTMLElement>('.request-panel .col-resizer') as HTMLElement
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await waitFor(() => expect(Number.parseFloat(keyCol().style.width)).toBe(before + 2))
    expect(JSON.parse(localStorage.getItem('specbook:grid-cols') ?? '{}').key).toBe(before + 2)

    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await waitFor(() => expect(Number.parseFloat(keyCol().style.width)).toBe(before))
    expect(localStorage.getItem('specbook:grid-cols')).toBeNull()
  })

  it('offers synthetic data as new each run or fixed with a seed number', async () => {
    await mount()
    const select = $<HTMLSelectElement>('select[aria-label="Synthetic data"]') as HTMLSelectElement
    expect(select.value).toBe('random')
    expect($('input[aria-label="Seed number"]')).toBeNull()

    type(select, 'fixed', 'change')
    await waitFor(() => expect(seed.value).toBe(42))
    const num = $<HTMLInputElement>('input[aria-label="Seed number"]') as HTMLInputElement
    num.value = '7'
    num.dispatchEvent(new Event('input', { bubbles: true }))
    await waitFor(() => expect(seed.value).toBe(7))

    type(select, 'random', 'change')
    await waitFor(() => expect(seed.value).toBeUndefined())
  })

  it('shows what the selected environment needs, with missing secrets counted', async () => {
    await mount()
    env.value = 'live'
    await waitFor(() => expect($('.envmenu-btn')).not.toBeNull())
    // the example project declares secrets and none are set in the test environment
    await waitFor(() => expect($('.badge-missing')?.textContent).toMatch(/^\d+$/))
    ;($('.envmenu-btn') as HTMLButtonElement).click()
    await waitFor(() => expect($('.envmenu-pop')).not.toBeNull())
    const names = [...root.querySelectorAll('.secretrow-head code')].map((c) => c.textContent)
    expect(names).toEqual(expect.arrayContaining(['PETSTORE_API_KEY', 'STRIPE_API_KEY']))
    expect($('.envmenu-pop .src.missing')).not.toBeNull()
    expect($('select[aria-label="Where to save secrets"]')).not.toBeNull()
  })

  it('lists an operation the spec gave no title as its path, and cleans HTML out of a description used as one', async () => {
    await mount()
    ;[...root.querySelectorAll<HTMLButtonElement>('.pills .pill')]
      .find((p) => p.textContent?.startsWith('stripe'))
      ?.click()
    catalogFilter.value = 'apple_pay'
    await waitFor(() => expect(root.querySelectorAll('.op-row').length).toBeGreaterThan(0))
    const rows = [...root.querySelectorAll('.op-row')].map((r) => r.textContent ?? '')
    // Stripe leaves `summary` out here and puts "<p>List apple pay domains.</p>" in the description
    expect(rows.some((t) => t.includes('List apple pay domains'))).toBe(true)
    expect(rows.every((t) => !t.includes('<p>'))).toBe(true)

    // and where it has neither, the row and the panel say which endpoint it is, not nothing
    catalogFilter.value = 'application_fees'
    await waitFor(() =>
      expect(
        [...root.querySelectorAll('.op-row')].some((r) =>
          r.textContent?.includes('/v1/application_fees/{id}/refund'),
        ),
      ).toBe(true),
    )
    go({ kind: 'op', key: 'stripe/PostApplicationFeesIdRefund', play: 'default' })
    await waitFor(() =>
      expect($('.panel-head .panel-title')?.textContent?.trim()).toMatch(
        /^\/v1\/application_fees\/\{id\}\/refund/,
      ),
    )
  })

  it('marks operations that need credentials with a lock', async () => {
    await mount()
    ;[...root.querySelectorAll<HTMLButtonElement>('.pills .pill')]
      .find((p) => p.textContent?.startsWith('petstore'))
      ?.click()
    await waitFor(() => expect(root.querySelectorAll('.op-row .op-lock').length).toBeGreaterThan(0))
    const locked = [...root.querySelectorAll('.op-row')].filter((r) => r.querySelector('.op-lock'))
    expect(locked.length).toBeLessThan(19)
  })

  it('shows the project branding: name, logo, tagline, links and accent', async () => {
    await mount()
    await waitFor(() => expect($('.brand')?.textContent).toContain('Specbook'))
    expect($('.brand .brand-logo')?.getAttribute('src')).toBeTruthy()
    // the headline is the title; the name sits above it
    expect($('.overview h1')?.textContent).toBe('API docs you can actually run')
    expect($('.overview .overview-name')?.textContent).toBe('Specbook')
    expect($('.overview .tagline')?.textContent).toContain('the real APIs')
    expect($('.overview-logo')).not.toBeNull()
    expect([...root.querySelectorAll('.overview-links a')].map((a) => a.textContent)).toEqual([
      'Stripe API reference',
      'GitHub REST docs',
    ])
    expect(document.title).toBe('Specbook · API docs you can actually run')
    expect(document.getElementById('specbook-brand')?.textContent).toContain('--sb-accent:#6d28d9')
  })

  it('cycles auto, light and dark, applies the theme to the page and remembers it', async () => {
    await mount()
    const toggle = () => $<HTMLButtonElement>('.theme-toggle') as HTMLButtonElement
    expect(document.documentElement.dataset.theme).toBeUndefined()

    toggle().click()
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
    toggle().click()
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
    expect(localStorage.getItem('specbook:theme')).toBe('dark')
    expect(getComputedStyle(document.body).backgroundColor).not.toBe('rgb(248, 250, 252)')

    toggle().click()
    await waitFor(() => expect(document.documentElement.dataset.theme).toBeUndefined())
    expect(localStorage.getItem('specbook:theme')).toBeNull()
  })

  it('renders a field markdown description under the editor when its line is selected', async () => {
    await mount()
    await play('stripe/PostPaymentIntents', 'default')
    await waitFor(() => expect(editor()?.value).toContain('"currency"'))
    await waitFor(async () => {
      const ta = editor() as HTMLTextAreaElement
      const at = ta.value.indexOf('"currency"')
      ta.focus()
      ta.setSelectionRange(at + 2, at + 2)
      document.dispatchEvent(new Event('selectionchange'))
      // Stripe's description links to the ISO list: that must be a real link, not `[text](url)`
      const link = $<HTMLAnchorElement>('.request-panel .field-doc-text a')
      expect(link?.getAttribute('href')).toContain('iso.org')
    })
    expect($('.request-panel .field-doc-text')?.textContent).not.toContain('](')
  })

  it('confirms where a saved example went and that it should be committed', async () => {
    // writing a project file is the dev server's job; this test only checks what the page does about it
    const real = globalThis.fetch
    const saves: { path: string; content: string }[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/__specbook/save')) {
        saves.push(JSON.parse(String(init?.body)))
        return new Response('{"ok":true}', { status: 200 })
      }
      return real(input, init)
    }) as typeof fetch
    try {
      await mount()
      await play('petstore/AddPet', 'default')
      await waitFor(() => expect(editor()?.value).toContain('doggie'))
      const ta = editor() as HTMLTextAreaElement
      type(ta as unknown as HTMLInputElement, ta.value.replace('doggie', 'a-new-pet'))
      await waitFor(() => expect(button('Save as example…')).toBeDefined())
      button('Save as example…').click()

      await waitFor(() => expect($('input[aria-label="Example name"]')).not.toBeNull())
      const name = $<HTMLInputElement>('input[aria-label="Example name"]') as HTMLInputElement
      type(name, 'My new pet')
      // the click of a person comes after the typed name has rendered
      await new Promise((r) => setTimeout(r, 60))
      button('Save').click()

      await waitFor(() => expect($('.saved-note')).not.toBeNull())
      expect(saves[0]?.path).toBe('requests/petstore/AddPet/my-new-pet.example.json')
      expect(JSON.parse(saves[0]?.content ?? '{}').body.name).toBe('a-new-pet')
      const note = $('.saved-note')?.textContent ?? ''
      expect(note).toContain('requests/petstore/AddPet/my-new-pet.example.json')
      expect(note).toContain('commit')

      button('×', $('.saved-note') as HTMLElement).click()
      await waitFor(() => expect($('.saved-note')).toBeNull())
    } finally {
      globalThis.fetch = real
      sessionStorage.removeItem('specbook:saved-example')
    }
  })
})
