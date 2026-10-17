import { defineOperation, sequence, withMock } from '@specbook/core'
import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { App } from '../../src/app'
import { catalogFilter, catalogService, go } from '../../src/nav'
import { SequencePanel } from '../../src/panel/SequencePanel'
import { env } from '../../src/store'
import 'prism-code-editor/layout.css'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'
import '../../src/styles/panel.css'

/** A run that is going can be stopped, on a desktop and on a phone, and ends in words, not in a wait. */

const Get = defineOperation<{
  params: { path: { orderId: number } }
  body: never
  responses: { 200: { id: number } }
}>({ service: 'petstore', id: 'GetOrderById', method: 'GET', path: '/store/order/{orderId}' })

/** A flow whose first request takes 20 seconds to be answered. */
const slow = () =>
  sequence({ id: 'slow', title: 'Slow' })
    .step(
      'Wait for it',
      withMock(Get.request({ path: { orderId: 5 } }), (_req, res) => {
        res.delayMs = 20_000
      }),
    )
    .step('Never reached', Get.request({ path: { orderId: 6 } }))

describe('stopping a run', () => {
  let root: HTMLElement
  beforeEach(() => {
    localStorage.clear()
    catalogService.value = ''
    catalogFilter.value = ''
    go({ kind: 'home' })
    root = document.createElement('div')
    document.body.append(root)
    env.value = 'mock'
  })
  afterEach(() => {
    render(null, root)
    document.body.innerHTML = ''
  })
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T | null
  const within = (el: Element) => {
    const r = el.getBoundingClientRect()
    return r.left >= 0 && r.right <= window.innerWidth
  }

  for (const [label, width] of [
    ['a desktop', 1280],
    ['a phone', 390],
  ] as const) {
    it(`ends a flow that is waiting on an answer, on ${label}`, async () => {
      const [w, h] = [window.innerWidth, window.innerHeight]
      await page.viewport(width, 844)
      try {
        render(<SequencePanel info={{ file: 'slow.seq.ts', seq: slow() }} />, root)
        ;(
          await vi.waitFor(() => $('.seq-run .btn.primary') as HTMLButtonElement, {
            timeout: 20_000,
          })
        ).click()
        // while it waits there is a Stop, in view, beside the disabled Run
        const stop = await vi.waitFor(
          () => {
            const b = [...root.querySelectorAll<HTMLButtonElement>('.seq-run .btn')].find(
              (x) => x.textContent === 'Stop',
            )
            expect(b).toBeDefined()
            return b as HTMLButtonElement
          },
          { timeout: 10_000 },
        )
        expect(within(stop)).toBe(true)
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
        // the first step is out, waiting on its answer
        await vi.waitFor(() => expect($('.jstep.running')).not.toBeNull(), { timeout: 10_000 })
        const t0 = Date.now()
        stop.click()
        // it ends at once, not after the twenty seconds, and says why
        await vi.waitFor(() => expect($('.seq-run .badge')).not.toBeNull(), { timeout: 5_000 })
        expect(Date.now() - t0).toBeLessThan(5_000)
        expect($('.seq-run .btn.primary')?.textContent).toContain('Run')
        expect($('.seq-run .btn.primary')?.textContent).not.toContain('Running')
        expect($('.jstep')?.textContent).toContain('Stopped')
        expect($('.seq-run .badge')?.textContent).toContain('Stopped')
        expect([...root.querySelectorAll('.jstep')].at(-1)?.textContent).toContain(
          'Skipped: you stopped the run.',
        )
        // and the Stop is gone, with nothing pushed off the screen
        expect(
          [...root.querySelectorAll('.seq-run .btn')].some((x) => x.textContent === 'Stop'),
        ).toBe(false)
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
        expect($('.panel-error')).toBeNull()
      } finally {
        await page.viewport(w, h)
      }
    })
  }

  it('turns Send into Stop while a request is out, in the same place, and ends it', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    await page.viewport(390, 844)
    // an API that takes the connection and never answers, as a real fetch does until it is told to give up
    const real = globalThis.fetch
    globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      // the app's own files load as usual: only the call to the API (GET /pet/1) never comes back
      if (!/\/pet\/\d+/.test(String(url))) return real(url, init)
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        )
      })
    }) as typeof fetch
    try {
      env.value = 'live'
      render(<App />, root)
      go({ kind: 'op', key: 'petstore/GetPetById', play: 'default' })
      const send = await vi.waitFor(
        () => {
          const b = $<HTMLButtonElement>('button[aria-label="Send"]')
          expect(b?.disabled).toBe(false)
          return b as HTMLButtonElement
        },
        { timeout: 30_000 },
      )
      const where = send.getBoundingClientRect()
      send.click()
      const stop = await vi.waitFor(
        () => {
          const b = $<HTMLButtonElement>('button[aria-label="Stop"]')
          expect(b).not.toBeNull()
          return b as HTMLButtonElement
        },
        { timeout: 10_000 },
      )
      // the same button, in the same place, with the same size: nothing moves on a phone
      const now = stop.getBoundingClientRect()
      expect([Math.round(now.left), Math.round(now.top), Math.round(now.width)]).toEqual([
        Math.round(where.left),
        Math.round(where.top),
        Math.round(where.width),
      ])
      expect(within(stop)).toBe(true)
      // pressed at once, before the request has even left: it must still end, not wait for an answer that never comes
      stop.click()
      await vi.waitFor(() => expect($('button[aria-label="Send"]')).not.toBeNull(), {
        timeout: 5_000,
      })
      await vi.waitFor(() => expect($('.response')?.textContent).toContain('Stopped'), {
        timeout: 5_000,
      })
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
    } finally {
      globalThis.fetch = real
      env.value = 'mock'
      await page.viewport(w, h)
    }
  })
})
