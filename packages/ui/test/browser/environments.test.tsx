import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { App } from '../../src/app'
import { catalogService, go } from '../../src/nav'
import { engine } from '../../src/runtime'
import { env, envSettingsOpen, newEnvironmentOpen } from '../../src/store'
import 'prism-code-editor/layout.css'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'
import '../../src/styles/panel.css'

// the example project's services are addressed by variables (`petstoreUrl`, …), all defaulting for `live`
describe('environments in the app', () => {
  let root: HTMLElement
  const posted: { url: string; body: unknown }[] = []
  const real = globalThis.fetch

  beforeEach(() => {
    localStorage.clear()
    catalogService.value = ''
    env.value = 'live'
    envSettingsOpen.value = false
    newEnvironmentOpen.value = false
    go({ kind: 'home' })
    root = document.createElement('div')
    document.body.append(root)
    posted.length = 0
    // making an environment writes a project file; here only what the page asks for is checked
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST' && url.startsWith('/__specbook/')) {
        posted.push({ url, body: JSON.parse(String(init.body)) })
        return new Response('{"ok":true}', { status: 200 })
      }
      return real(input, init)
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = real
    render(null, root)
    document.body.innerHTML = ''
    env.value = 'mock'
  })

  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T | null
  const waitFor = (fn: () => void) => vi.waitFor(fn, { timeout: 15_000 })
  const mount = async () => {
    render(<App />, root)
    await waitFor(() => expect($('.envmenu-btn')).not.toBeNull())
  }
  const type = (el: HTMLInputElement, v: string) => {
    el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('shows the defaults a variable gives each service, and where its calls go', async () => {
    await mount()
    ;($('.envmenu-btn') as HTMLButtonElement).click()
    await waitFor(() => expect($('.envmenu-pop')).not.toBeNull())
    const row = () =>
      [...root.querySelectorAll('.envmenu-pop .envrow')].find(
        (r) => r.querySelector('code')?.textContent === 'petstoreUrl',
      )
    await waitFor(() => expect(row()).toBeDefined())
    expect(row()?.querySelector('input')?.value).toBe('https://petstore3.swagger.io/api/v3')
    expect(row()?.querySelector('.src')?.textContent).toBe('default')
    // an inherited value has nothing of its own to reset
    expect(row()?.querySelector('button[aria-label^="Reset"]')).toBeNull()
    expect(root.querySelector('.envmenu-pop')?.textContent).toContain(
      'petstore calls go to https://petstore3.swagger.io/api/v3',
    )
  })

  it('makes an environment as a copy of the one being looked at, and opens its settings', async () => {
    await mount()
    const picker = $('.header-controls select, .header select') as HTMLSelectElement
    const choices = [...picker.options]
    const make = choices.find((o) => o.textContent === 'New environment…')
    expect(make).toBeDefined()
    picker.value = make?.value ?? ''
    picker.dispatchEvent(new Event('change', { bubbles: true }))
    // choosing it opens the dialog and leaves the selection alone
    await waitFor(() => expect($('[aria-label="New environment"]')).not.toBeNull())
    expect(env.value).toBe('live')
    expect(($('select[aria-label="Duplicate of"]') as HTMLSelectElement).value).toBe('live')

    const create = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Create')
    expect((create as HTMLButtonElement).disabled).toBe(true)
    type($('input[aria-label="Environment name"]') as HTMLInputElement, 'live')
    await waitFor(() => expect(root.textContent).toContain('"live" already exists'))
    type($('input[aria-label="Environment name"]') as HTMLInputElement, 'fork')
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false))
    ;(create as HTMLButtonElement).click()

    await waitFor(() => expect(env.value).toBe('fork'))
    expect(posted).toContainEqual({
      url: '/__specbook/environment',
      body: { name: 'fork', from: 'live' },
    })
    // it is in the picker now, and its settings are open
    await waitFor(() => expect([...(picker.options ?? [])].map((o) => o.value)).toContain('fork'))
    await waitFor(() => expect($('.envmenu-pop')).not.toBeNull())
  })

  it('writes an edited address to the environment, so its calls go there', async () => {
    await mount()
    ;($('.envmenu-btn') as HTMLButtonElement).click()
    const input = () =>
      $('.envmenu-pop input[aria-label="Value of petstoreUrl"]') as HTMLInputElement | null
    await waitFor(() => expect(input()).not.toBeNull())
    ;(input() as HTMLInputElement).focus()
    type(input() as HTMLInputElement, 'http://localhost:9000/v3')
    await new Promise((r) => setTimeout(r, 60))
    // leaving the field saves it (a synthetic event: the test page may not hold focus)
    input()?.dispatchEvent(new FocusEvent('blur'))
    await waitFor(() =>
      expect(posted).toContainEqual({
        url: '/__specbook/var',
        body: { env: 'live', name: 'petstoreUrl', value: 'http://localhost:9000/v3' },
      }),
    )
  })

  it('says a secret only a server holds is never sent to the page, and says nothing of the others', async () => {
    const original = engine.config.bind(engine)
    vi.spyOn(engine, 'config').mockImplementation(async (v: number) => {
      const c = await original(v)
      return {
        ...c,
        auth: {
          ...c.auth,
          'client-credentials': {
            title: 'OAuth client credentials',
            apply: { headers: { authorization: 'Bearer {{session.accessToken}}' } },
            oauth: {
              tokenUrl: 'https://idp.example.test/token',
              clientId: '{{secrets.PETSTORE_AUTH}}',
              clientSecret: '{{secrets.PETSTORE_AUTH}}',
            },
          },
        },
      } as never
    })
    await mount()
    ;($('.envmenu-btn') as HTMLButtonElement).click()
    await waitFor(() => expect($('.envmenu-pop .secretrow')).not.toBeNull())
    const rows = () => [...root.querySelectorAll('.envmenu-pop .secretrow')]
    const row = (name: string) =>
      rows().find((r) => r.querySelector('code')?.textContent?.includes(name))
    await waitFor(() =>
      expect(row('PETSTORE_AUTH')?.querySelector('.secret-server')?.textContent).toContain(
        'Never sent to the page',
      ),
    )
    expect(row('PETSTORE_API_KEY')?.querySelector('.secret-server')).toBeNull()
    vi.restoreAllMocks()
  })

  it('fits a phone: the settings and the dialog stay inside the screen, with room for an address', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    await page.viewport(390, 844)
    try {
      await mount()
      // on a phone the header controls sit behind the menu button
      ;($('.menu-btn') as HTMLButtonElement).click()
      await waitFor(() =>
        expect(getComputedStyle($('.header-controls') as Element).display).not.toBe('none'),
      )
      // the menu's labelled controls line up: one left edge and one width for every select
      const selects = [...root.querySelectorAll('.header-controls select')].map((e) =>
        e.getBoundingClientRect(),
      )
      expect(selects.length).toBeGreaterThan(1)
      expect(new Set(selects.map((r) => Math.round(r.left))).size).toBe(1)
      expect(new Set(selects.map((r) => Math.round(r.width))).size).toBe(1)
      ;($('.envmenu-btn') as HTMLButtonElement).click()
      await waitFor(() => expect($('.envmenu-pop')).not.toBeNull())
      const pop = $('.envmenu-pop') as HTMLElement
      await waitFor(() =>
        expect(pop.querySelector('input[aria-label="Value of petstoreUrl"]')).not.toBeNull(),
      )
      // the close button sits at the popover's right edge, not beside the title
      const close = pop.querySelector('button[aria-label="Close"]') as HTMLElement
      expect(pop.getBoundingClientRect().right - close.getBoundingClientRect().right).toBeLessThan(
        24,
      )
      expect(pop.scrollWidth).toBeLessThanOrEqual(pop.clientWidth)
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
      const address = pop.querySelector('input[aria-label="Value of petstoreUrl"]') as HTMLElement
      // the address field is most of the popover's width, not squeezed beside its name
      expect(address.getBoundingClientRect().width).toBeGreaterThan(pop.clientWidth * 0.55)
      for (const input of pop.querySelectorAll('input'))
        expect(parseFloat(getComputedStyle(input).fontSize)).toBeGreaterThanOrEqual(16)
      envSettingsOpen.value = false
      newEnvironmentOpen.value = true
      await waitFor(() => expect($('.newenv')).not.toBeNull())
      const box = ($('.newenv') as HTMLElement).getBoundingClientRect()
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(window.innerWidth)
      for (const f of document.querySelectorAll('.newenv input, .newenv select'))
        expect(parseFloat(getComputedStyle(f).fontSize)).toBeGreaterThanOrEqual(16)
    } finally {
      await page.viewport(w, h)
    }
  })
})
