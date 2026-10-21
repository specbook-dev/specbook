import type { StepResult } from '@specbook/core'
import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VIA_HEADER } from '../../src/extension'
import { ExtensionNudge } from '../../src/panel/ExtensionNudge'
import { ResponseView } from '../../src/panel/ResponseView'
import { engine } from '../../src/runtime'
import { env } from '../../src/store'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'
import '../../src/styles/panel.css'

const API = 'https://api.acme.com'

describe('what the person can do about a failed call, said in the failed response', () => {
  let host: HTMLElement
  beforeEach(() => {
    host = document.body.appendChild(document.createElement('div'))
    env.value = 'live'
  })
  afterEach(() => {
    render(null, host)
    host.remove()
    env.value = 'mock'
    vi.restoreAllMocks()
  })
  const show = (hint?: { code: string; origin?: string }, services?: string[]) =>
    render(<ExtensionNudge hint={hint} services={services} />, host)
  const button = (name: string) =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === name)

  it('a call the browser blocked: the extension can send it, with a link and what to do if installed', () => {
    show({ code: 'cors', origin: API })
    expect(host.textContent).toContain('can send this call for you')
    expect(host.textContent).toContain('api.acme.com')
    expect(host.textContent).toContain('choose Enable.')
    // the install steps, which link the download
    expect(host.querySelector('a')?.getAttribute('href')).toBe(
      'https://docs.specbook.dev/reference/browser-extension/',
    )
    expect(host.querySelector('a')?.getAttribute('target')).toBe('_blank')
    expect(host.querySelector('button')).toBeNull()
  })

  it('offers no install where there is none for this browser', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
    )
    show({ code: 'cors', origin: API })
    expect(host.textContent).toBe('')
  })

  it('an extension that is out of date: says so, with a link to update it', () => {
    show({ code: 'outdated', origin: API })
    expect(host.textContent).toContain('out of date')
    expect(host.textContent).toContain('api.acme.com')
    expect(host.querySelector('a')?.textContent).toBe('Update it')
  })

  it('an API this page may not call yet: Allow asks for it and for what else the flow needs', async () => {
    vi.spyOn(engine, 'extensionState').mockResolvedValue({
      state: 'ready',
      needed: [API, 'https://auth.acme.com'],
      missing: ['https://auth.acme.com'],
    })
    const grant = vi
      .spyOn(engine, 'requestExtensionGrant')
      .mockResolvedValue({ granted: [], missing: [] })
    show({ code: 'not-allowed', origin: API }, ['shop', 'auth'])
    expect(host.textContent).toContain('has not been allowed to call api.acme.com')

    button('Allow')?.click()
    await vi.waitFor(() => expect(grant).toHaveBeenCalled())
    expect(grant).toHaveBeenCalledWith([API, 'https://auth.acme.com'])
    await vi.waitFor(() =>
      expect(host.textContent).toContain(
        'Choose Allow in the extension’s window, then run it again',
      ),
    )
  })

  it('an API it may read but not modify: Allow modifying data asks about modifying only', async () => {
    const grant = vi
      .spyOn(engine, 'requestExtensionGrant')
      .mockResolvedValue({ granted: [API], missing: [] })
    show({ code: 'read-only', origin: API })
    expect(host.textContent).toContain('can read api.acme.com')
    expect(host.textContent).toContain('not been allowed to modify data')

    button('Allow modifying data')?.click()
    expect(grant).toHaveBeenCalledWith([API], { writes: true })
    await vi.waitFor(() =>
      expect(host.textContent).toContain(
        'Tick Modify data in the extension’s window, then run it again',
      ),
    )
  })

  it('says nothing for any other failure, or when there is no hint', () => {
    for (const hint of [
      undefined,
      { code: 'timeout', origin: API },
      { code: 'rate-limited', origin: API },
      { code: 'cors' },
    ]) {
      render(null, host)
      show(hint)
      expect(host.textContent, JSON.stringify(hint)).toBe('')
    }
  })
})

describe('the response panel', () => {
  let host: HTMLElement
  beforeEach(() => {
    host = document.body.appendChild(document.createElement('div'))
  })
  afterEach(() => {
    render(null, host)
    host.remove()
  })
  const failed = (over: Partial<StepResult>): StepResult => ({
    name: 'Get the latest comic',
    kind: 'request',
    status: 'error',
    assertions: [],
    captured: {},
    durationMs: 3,
    ...over,
  })

  it('shows the failure, and under it what can be done, in one place', () => {
    render(
      <ResponseView
        step={failed({
          error: 'The browser could not reach xkcd',
          errorHint: { code: 'cors', origin: 'https://xkcd.com' },
        })}
      />,
      host,
    )
    expect(host.querySelector('.error-text')?.textContent).toContain('could not reach xkcd')
    expect(host.querySelector('.ext-nudge')?.textContent).toContain('xkcd.com')
  })

  it('does not say it twice when the nudge already puts the refusal in plain words', () => {
    for (const code of ['not-allowed', 'read-only']) {
      render(null, host)
      render(
        <ResponseView
          step={failed({
            error: 'https://api.acme.com has not been allowed for the site',
            errorHint: { code, origin: 'https://api.acme.com' },
          })}
        />,
        host,
      )
      expect(host.querySelector('.ext-nudge'), code).not.toBeNull()
      expect(host.querySelector('.error-text'), code).toBeNull()
    }
  })

  it('keeps the message beside the nudge when the message says why and the nudge says what to do', () => {
    for (const code of ['cors', 'outdated']) {
      render(null, host)
      render(
        <ResponseView
          step={failed({
            error: 'The browser could not reach it',
            errorHint: { code, origin: 'https://api.acme.com' },
          })}
        />,
        host,
      )
      expect(host.querySelector('.ext-nudge'), code).not.toBeNull()
      expect(host.querySelector('.error-text')?.textContent, code).toContain('could not reach')
    }
  })

  it('keeps the message when the hint has no origin to name, since the nudge then shows nothing', () => {
    render(
      <ResponseView step={failed({ error: 'refused', errorHint: { code: 'not-allowed' } })} />,
      host,
    )
    expect(host.querySelector('.ext-nudge')).toBeNull()
    expect(host.querySelector('.error-text')?.textContent).toBe('refused')
  })

  it('shows no nudge for a failure with no hint', () => {
    render(<ResponseView step={failed({ error: 'connection reset' })} />, host)
    expect(host.querySelector('.error-text')?.textContent).toBe('connection reset')
    expect(host.querySelector('.ext-nudge')).toBeNull()
  })

  it('notes a response that came through the extension', () => {
    const through = failed({
      status: 'pass',
      response: {
        status: 200,
        headers: { [VIA_HEADER]: 'extension' },
        body: { ok: true },
        durationMs: 4,
      },
    })
    render(<ResponseView step={through} />, host)
    expect(host.textContent).toContain('via extension')

    render(null, host)
    const direct = failed({
      status: 'pass',
      response: { status: 200, headers: {}, body: { ok: true }, durationMs: 4 },
    })
    render(<ResponseView step={direct} />, host)
    expect(host.textContent).not.toContain('via extension')
  })
})
