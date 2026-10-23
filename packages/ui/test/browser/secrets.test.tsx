import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { SecretsBar } from '../../src/panel/SecretsBar'
import { secretStore } from '../../src/secrets'
import { env } from '../../src/store'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'
import '../../src/styles/panel.css'

const origin = 'https://petstore3.swagger.io'

describe('the credentials prompt on a static page', () => {
  let host: HTMLElement
  beforeEach(() => {
    host = document.body.appendChild(document.createElement('div'))
    env.value = 'live'
  })
  afterEach(() => {
    render(null, host)
    host.remove()
    env.value = 'mock'
    secretStore.remove(origin, 'PETSTORE_API_KEY')
  })

  it('asks for the key the service needs, keeps it for the API origin, and can clear it', async () => {
    render(<SecretsBar services={['petstore']} supplied={{}} />, host)
    const input = await vi.waitFor(() => {
      const el = host.querySelector<HTMLInputElement>('input[type="password"]')
      expect(el).not.toBeNull()
      return el as HTMLInputElement
    })
    expect(input.getAttribute('aria-label')).toBe('PETSTORE_API_KEY for petstore')
    expect(host.textContent).toContain('Kept in this tab only')

    input.value = 'k-123'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    // filled in: the prompt folds to one chip that says so
    await vi.waitFor(() => expect(host.querySelector('.secrets-chip')).not.toBeNull())
    expect(host.textContent).toContain('✓')
    expect(host.querySelector('fieldset')).toBeNull()
    expect(secretStore.get(origin, 'PETSTORE_API_KEY')).toBe('k-123')
    // the value itself is never written back into the page
    expect(host.innerHTML).not.toContain('k-123')

    // a tap on the chip brings the fields back
    ;(host.querySelector('.secrets-chip') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.textContent).toContain('✓ set'))

    const clear = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Clear')
    clear?.click()
    await vi.waitFor(() => expect(host.querySelector('input[type="password"]')).not.toBeNull())
    expect(secretStore.get(origin, 'PETSTORE_API_KEY')).toBeUndefined()
  })

  it('shows nothing for the mock environment or when the caller turns it off', async () => {
    env.value = 'mock'
    render(<SecretsBar services={['petstore']} supplied={{}} />, host)
    await new Promise((r) => setTimeout(r, 100))
    expect(host.querySelector('fieldset')).toBeNull()
    env.value = 'live'
    render(<SecretsBar services={['petstore']} enabled={false} />, host)
    await new Promise((r) => setTimeout(r, 100))
    expect(host.querySelector('fieldset')).toBeNull()
  })

  it('fits a phone: inside the panel width, fields at 16px so iOS does not zoom', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    await page.viewport(390, 844)
    try {
      render(
        <div class="panel">
          <div class="request-panel">
            <div class="rq">
              <SecretsBar services={['petstore']} supplied={{}} />
            </div>
          </div>
        </div>,
        host,
      )
      const bar = await vi.waitFor(() => {
        const el = host.querySelector<HTMLElement>('fieldset.needs-vars')
        expect(el).not.toBeNull()
        return el as HTMLElement
      })
      // measured against the panel: it slides in (a transform) for 160ms, which moves both together
      const r = bar.getBoundingClientRect()
      const panel = (host.querySelector('.panel') as HTMLElement).getBoundingClientRect()
      expect(r.left - panel.left).toBeGreaterThanOrEqual(0)
      expect(r.right - panel.left).toBeLessThanOrEqual(390)
      expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth)
      const input = bar.querySelector('input[type="password"]') as HTMLInputElement
      expect(parseFloat(getComputedStyle(input).fontSize)).toBeGreaterThanOrEqual(16)
      expect(input.getBoundingClientRect().height).toBeGreaterThanOrEqual(36)
    } finally {
      await page.viewport(w, h)
    }
  })

  it('lists what the dev server already supplies, asks only for what nothing does, and lets you override', async () => {
    render(
      <SecretsBar services={['petstore']} supplied={{ PETSTORE_API_KEY: 'environment' }} />,
      host,
    )
    // supplied by an environment file: nothing is missing, so it folds to the chip
    await vi.waitFor(() => expect(host.querySelector('.secrets-chip')).not.toBeNull())
    expect(host.querySelector('fieldset')).toBeNull()
    ;(host.querySelector('.secrets-chip') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.textContent).toContain('from environment file'))
    const input = host.querySelector('input[type="password"]') as HTMLInputElement
    expect(input.placeholder).toBe('use another value')
    input.value = 'mine'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    // the page's own value is held for the API origin, to be sent to the dev server
    await vi.waitFor(() => expect(secretStore.get(origin, 'PETSTORE_API_KEY')).toBe('mine'))
  })

  it('asks for a name no executor supplies', async () => {
    render(<SecretsBar services={['petstore']} supplied={{ SOMETHING_ELSE: 'process' }} />, host)
    await vi.waitFor(() => expect(host.querySelector('fieldset.needs-vars')).not.toBeNull())
    const input = host.querySelector('input[type="password"]') as HTMLInputElement
    expect(input.placeholder).toBe('enter value')
  })
})
