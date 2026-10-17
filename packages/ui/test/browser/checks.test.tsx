import { defineOperation, type RunResult, type StepResult, sequence } from '@specbook/core'
import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ResponseView } from '../../src/panel/ResponseView'
import { SequencePanel } from '../../src/panel/SequencePanel'
import { env } from '../../src/store'
import 'prism-code-editor/layout.css'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'
import '../../src/styles/panel.css'

const failing: StepResult = {
  name: 'Get pet',
  kind: 'request',
  status: 'fail',
  durationMs: 12,
  captured: {},
  response: {
    status: 404,
    headers: { 'content-type': 'application/json' },
    body: { message: 'no such pet' },
    durationMs: 12,
  },
  assertions: [
    { label: 'found', operator: 'is', pass: true },
    {
      label: 'name is Rover',
      operator: 'equal',
      pass: false,
      expected: { id: 1, name: 'Rover', tags: ['a', 'b'] },
      actual: { id: 1, name: 'Rex', tags: ['a', 'b'] },
    },
    { label: 'status is 2xx', operator: 'status', pass: false, actual: 404, expected: '2xx' },
  ],
}

describe('failing checks', () => {
  let root: HTMLElement
  beforeEach(() => {
    root = document.createElement('div')
    document.body.append(root)
  })
  afterEach(async () => {
    render(null, root)
    document.body.innerHTML = ''
    delete document.documentElement.dataset.theme
    env.value = 'mock'
  })
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T | null

  it('opens the Checks tab by itself, counts what failed, and shows expected and received as a diff', async () => {
    render(<ResponseView step={failing} />, root)
    await vi.waitFor(() => expect($('.check-fail')).not.toBeNull())
    const tab = [...root.querySelectorAll<HTMLElement>('[role=tab]')].find((t) =>
      t.textContent?.startsWith('Checks'),
    ) as HTMLElement
    await vi.waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'))
    // the badge is the number that failed, in red, not the number of checks
    const badge = tab.querySelector('.count') as HTMLElement
    expect(badge.textContent).toBe('2')
    expect(badge.classList.contains('bad')).toBe(true)

    expect(root.querySelectorAll('.check-fail')).toHaveLength(2)
    expect($('.checks .ok')?.textContent).toBe('✓ found')
    // only the tick is green: the sentence is muted, as the panel's secondary text is
    const tick = getComputedStyle($('.checks .ok .tick') as HTMLElement).color
    const label = getComputedStyle($('.checks .ok') as HTMLElement).color
    expect(tick).not.toBe(label)
    const muted = document.createElement('span')
    muted.style.color = 'var(--sb-text-muted)'
    root.append(muted)
    expect(label).toBe(getComputedStyle(muted).color)
    muted.remove()
    const first = $('.check-fail') as HTMLElement
    expect(first.textContent).toContain('name is Rover')
    const text = (sel: string) =>
      [...first.querySelectorAll(sel)].map((l) => l.querySelector('.diff-text')?.textContent)
    expect(text('.diff-line.diff-expected')).toEqual(['  "name": "Rover",'])
    expect(text('.diff-line.diff-received')).toEqual(['  "name": "Rex",'])
    expect(first.querySelector('.diff-legend')?.textContent).toContain('Expected')
    // the status check reads in words
    const second = root.querySelectorAll('.check-fail')[1] as HTMLElement
    expect(second.textContent).toContain('status 2xx')
    expect(second.textContent).toContain('status 404 Not Found')
  })

  it('colors what was expected and what was received differently, in both themes, and not by color alone', async () => {
    render(<ResponseView step={failing} />, root)
    await vi.waitFor(() => expect($('.diff-expected')).not.toBeNull())
    for (const theme of ['light', 'dark'] as const) {
      document.documentElement.dataset.theme = theme
      await new Promise((r) => setTimeout(r, 50))
      const want = getComputedStyle($('.diff-line.diff-expected') as Element)
      const got = getComputedStyle($('.diff-line.diff-received') as Element)
      expect(want.backgroundColor, theme).not.toBe(got.backgroundColor)
      expect(want.color, theme).not.toBe(got.color)
      expect(want.backgroundColor, theme).not.toBe('rgba(0, 0, 0, 0)')
    }
    // a gutter sign and a spoken prefix say it too
    expect($('.diff-expected .diff-gutter')?.textContent).toBe('−')
    expect($('.diff-received .diff-gutter')?.textContent).toBe('+')
    expect($('.diff-expected .visually-hidden')?.textContent).toBe('expected: ')
  })

  it('keeps a long value inside its block on a phone, not the page', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    await page.viewport(390, 844)
    try {
      const long = { token: 'x'.repeat(400) }
      const step: StepResult = {
        ...failing,
        assertions: [
          {
            label: 'same token',
            operator: 'equal',
            pass: false,
            expected: long,
            actual: { token: 'y' },
          },
        ],
      }
      render(<ResponseView step={step} />, root)
      // the Checks tab opens itself, so the block has a size once that is done
      await vi.waitFor(() =>
        expect(($('.diff') as HTMLElement | null)?.clientWidth).toBeGreaterThan(0),
      )
      const diff = $('.diff') as HTMLElement
      expect(diff.scrollWidth).toBeGreaterThan(diff.clientWidth)
      expect(getComputedStyle(diff).overflowX).toBe('auto')
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
    } finally {
      await page.viewport(w, h)
    }
  })

  it('shows a flow its first failing step with the same card, and a summary of what failed', async () => {
    const GetOrderById = defineOperation<{
      params: { path: { orderId: number } }
      body: never
      responses: { 200: { id: number } }
    }>({ service: 'petstore', id: 'GetOrderById', method: 'GET', path: '/store/order/{orderId}' })
    const seq = sequence({ id: 'checks-demo', title: 'Checks demo' })
      .step(
        'Look it up',
        GetOrderById.request({
          path: { orderId: 5 },
          assert: (res, { assert }) => assert.is(res.status, 404, 'expects a missing order'),
        }),
      )
      .step('Never reached', GetOrderById.request({ path: { orderId: 6 } }))
    env.value = 'mock'
    render(<SequencePanel info={{ file: 'checks-demo.seq.ts', seq }} />, root)
    ;(
      await vi.waitFor(() => $('.seq-run .btn.primary') as HTMLButtonElement, { timeout: 20_000 })
    ).click()
    await vi.waitFor(() => expect($('.jstep .check-fail')).not.toBeNull(), { timeout: 20_000 })
    const card = $('.jstep .check-fail') as HTMLElement
    expect(card.textContent).toContain('expects a missing order')
    expect(card.querySelector('.diff-expected .diff-text')?.textContent).toBe('404')
    expect(card.querySelector('.diff-received .diff-text')?.textContent).toBe('200')
    expect($('.seq-run .badge')?.textContent).toContain('Failed')
    // the failing step is the one open on the right, with the same card in its Checks tab
    await vi.waitFor(() => expect($('.seq-right .check-fail')).not.toBeNull())
    expect($('.jstep.picked')?.textContent).toContain('Look it up')
  })

  it('has nothing to show for a run that passed', async () => {
    const ok: RunResult['steps'][number] = {
      ...failing,
      status: 'pass',
      assertions: [{ label: 'ok', operator: 'is', pass: true }],
    }
    render(<ResponseView step={ok} />, root)
    await vi.waitFor(() => expect($('.state-badge')).not.toBeNull())
    expect($('.check-fail')).toBeNull()
    const tab = [...root.querySelectorAll<HTMLElement>('[role=tab]')].find((t) =>
      t.textContent?.startsWith('Checks'),
    ) as HTMLElement
    expect(tab.getAttribute('aria-selected')).toBe('false')
    expect(tab.querySelector('.count')?.classList.contains('bad')).toBe(false)
  })
})
