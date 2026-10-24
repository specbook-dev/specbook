import { c, defineOperation, sequence } from '@specbook/core'
import { faker } from '@specbook/core/faker'
import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { SequencePanel } from '../../src/panel/SequencePanel'
import { env, locale, seed } from '../../src/store'
import 'prism-code-editor/layout.css'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'
import '../../src/styles/panel.css'

const GetOrderById = defineOperation<{
  params: { path: { orderId: number } }
  body: never
  responses: { 200: { id: number } }
}>({ service: 'petstore', id: 'GetOrderById', method: 'GET', path: '/store/order/{orderId}' })
const look = GetOrderById.request({ path: { orderId: 5 } })

const traveler = (label?: string) =>
  c.object(
    {
      name: c.text({ default: () => faker.person.fullName() }),
      gender: c.select(['F', 'M', 'X'] as const),
      dob: c.date({ default: '1990-01-01' }),
    },
    { label },
  )

const groups = sequence({
  id: 'groups',
  title: 'Two travelers',
  inputs: {
    currency: c.select(['usd', 'eur'] as const),
    traveler1: traveler('Traveler 1'),
    traveler2: traveler('Traveler 2'),
  },
}).step('Look it up', look)

const list = sequence({
  id: 'list',
  title: 'Travelers',
  inputs: { travelers: c.array(traveler(), { min: 1, max: 4, label: 'Travelers' }) },
}).step('Look it up', look)

describe('the Inputs stop and the forms of groups and lists', () => {
  let root: HTMLElement
  beforeEach(() => {
    root = document.createElement('div')
    root.style.cssText = 'width:100%;height:700px'
    document.body.append(root)
    env.value = 'mock'
  })
  afterEach(() => {
    render(null, root)
    document.body.innerHTML = ''
    env.value = 'mock'
    locale.value = undefined
    seed.value = undefined
  })
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T | null
  const $$ = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)]
  const field = (name: string) => $<HTMLInputElement>(`input[aria-label="${name}"]`)
  const button = (text: string) =>
    $$('button').find((b) => b.textContent?.includes(text)) as HTMLButtonElement
  const type = (el: HTMLInputElement, v: string, event = 'input') => {
    el.value = v
    el.dispatchEvent(new Event(event, { bubbles: true }))
  }
  // a person's next action comes after the form has drawn what was typed
  const tick = () => new Promise((r) => setTimeout(r, 50))
  const ready = () =>
    vi.waitFor(
      () =>
        expect(field('traveler1.name')?.value || field('travelers[0].name')?.value).toBeTruthy(),
      {
        timeout: 20_000,
      },
    )
  const show = (
    seq: Parameters<typeof SequencePanel>[0]['info']['seq'],
    file: string,
    preset?: Record<string, unknown>,
  ) => render(<SequencePanel info={{ file, seq }} preset={preset} />, root)
  const viewport = async (w: number, h: number, body: () => Promise<void>) => {
    const [ow, oh] = [window.innerWidth, window.innerHeight]
    await page.viewport(w, h)
    try {
      await body()
    } finally {
      await page.viewport(ow, oh)
    }
  }

  it('on a wide screen the form is the right pane until a step is picked, and comes back with what was typed', async () => {
    await viewport(1280, 800, async () => {
      show(groups, 'groups-wide.seq.ts')
      await ready()
      expect($('.seq-right .seq-inputs .controls-grid')).not.toBeNull()
      expect($('.seq-left .controls-grid')).toBeNull()
      expect($('.jin-head')?.getAttribute('aria-current')).toBe('step')
      type(field('traveler1.name') as HTMLInputElement, 'Ada Lovelace')
      // the stop says what the run starts from
      await vi.waitFor(() => expect($('.jin-sum')?.textContent).toContain('currency'))

      button('▶ Run').click()
      await vi.waitFor(() => expect($('.step-exchange')).not.toBeNull(), { timeout: 20_000 })
      expect($('.seq-inputs')).toBeNull()
      expect($('.jin-head')?.getAttribute('aria-current')).toBeNull()

      $('.jin-head')?.click()
      await vi.waitFor(() => expect($('.seq-right .seq-inputs')).not.toBeNull())
      expect(field('traveler1.name')?.value).toBe('Ada Lovelace')
    })
  })

  it('draws neighbouring groups of the same fields as one table, a row each, and regenerates only what is generated', async () => {
    await viewport(1280, 800, async () => {
      show(groups, 'groups-table.seq.ts')
      await ready()
      expect($$('.group-table')).toHaveLength(1)
      expect($$('.group-table tbody tr')).toHaveLength(2)
      expect($$('.group-table tbody th .g-heading').map((h) => h.textContent)).toEqual([
        'Traveler 1',
        'Traveler 2',
      ])
      expect($$('.group-table thead th').map((h) => h.textContent)).toEqual([
        '',
        'name',
        'gender',
        'dob',
      ])
      // one die for the row, none inside it: what QA does not like they type over
      expect($$('.group-table .cell-gen')).toHaveLength(0)
      expect(
        $$('.group-table button[aria-label^="Generate"]').map((b) => b.getAttribute('aria-label')),
      ).toEqual(['Generate traveler1', 'Generate traveler2'])
      const before = field('traveler1.name')?.value
      type(field('traveler1.dob') as HTMLInputElement, '2000-02-02')
      await tick()
      ;($('button[aria-label="Generate traveler1"]') as HTMLButtonElement).click()
      await vi.waitFor(() => expect(field('traveler1.name')?.value).not.toBe(before))
      expect(field('traveler1.dob')?.value).toBe('2000-02-02')
    })
  })

  it('a list has a count, clamped to its limits, and gives back the rows it trimmed', async () => {
    await viewport(1280, 800, async () => {
      show(list, 'list.seq.ts')
      await ready()
      const count = () => field('travelers count') as HTMLInputElement
      expect($$('.group-table tbody tr')).toHaveLength(1)
      expect(($('button[aria-label="Remove travelers[0]"]') as HTMLButtonElement).disabled).toBe(
        true,
      )

      type(count(), '3', 'change')
      await vi.waitFor(() => expect($$('.group-table tbody tr')).toHaveLength(3))
      // new rows start from generated values
      expect(field('travelers[2].name')?.value).toBeTruthy()
      type(count(), '10', 'change')
      await vi.waitFor(() => expect($$('.group-table tbody tr')).toHaveLength(4))
      expect(count().value).toBe('4')

      type(field('travelers[3].name') as HTMLInputElement, 'Kept Name')
      await tick()
      type(count(), '2', 'change')
      await vi.waitFor(() => expect($$('.group-table tbody tr')).toHaveLength(2))
      type(count(), '4', 'change')
      await vi.waitFor(() => expect($$('.group-table tbody tr')).toHaveLength(4))
      expect(field('travelers[3].name')?.value).toBe('Kept Name')

      ;($('button[aria-label="Remove travelers[1]"]') as HTMLButtonElement).click()
      await vi.waitFor(() => expect($$('.group-table tbody tr')).toHaveLength(3))
      expect(field('travelers[2].name')?.value).toBe('Kept Name')
    })
  })

  it('Run with defaults works on a list that has a minimum and nothing given', async () => {
    await viewport(1280, 800, async () => {
      show(list, 'list-defaults.seq.ts')
      await ready()
      button('Run with defaults').click()
      await vi.waitFor(() => expect($('.badge.pass')).not.toBeNull(), { timeout: 20_000 })
    })
  })

  it('a preset of one field of a group leaves the rest of the group at its defaults', async () => {
    await viewport(1280, 800, async () => {
      show(groups, 'groups-preset.seq.ts', { traveler2: { name: 'Preset Person' } })
      await vi.waitFor(() => expect(field('traveler2.name')?.value).toBe('Preset Person'), {
        timeout: 20_000,
      })
      expect(field('traveler2.dob')?.value).toBe('1990-01-01')
      expect(field('traveler1.name')?.value).toBeTruthy()
    })
  })

  it('on a phone the form unfolds under its stop as cards, folds away for a run, and keeps Run in reach', async () => {
    await viewport(390, 844, async () => {
      show(list, 'list-phone.seq.ts')
      await ready()
      expect($('.jin-form .controls-grid')).not.toBeNull()
      expect(getComputedStyle($('.seq-right') as HTMLElement).display).toBe('none')
      expect($('.jin-head')?.getAttribute('aria-expanded')).toBe('true')
      // each group is a card: a label over each control, no header row
      expect(getComputedStyle($('.group-table thead') as HTMLElement).display).toBe('none')
      expect(getComputedStyle($('.group-table .g-label') as HTMLElement).display).toBe('block')
      type($('input[aria-label="travelers count"]') as HTMLInputElement, '4', 'change')
      await vi.waitFor(() => expect($$('.group-table tbody tr')).toHaveLength(4))
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
      for (const el of $$('.group-table button, .group-table input')) {
        const r = el.getBoundingClientRect()
        expect(r.right, el.getAttribute('aria-label') ?? '').toBeLessThanOrEqual(window.innerWidth)
      }

      // scrolled to the bottom of a long form, Run is still on screen
      const left = $('.seq-left') as HTMLElement
      left.scrollTop = left.scrollHeight
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      // pinned flush with the top of what scrolls: nothing shows through a gap above it
      const row = ($('.seq-left .seq-run') as HTMLElement).getBoundingClientRect()
      expect(Math.abs(row.top - left.getBoundingClientRect().top)).toBeLessThan(1)
      const run = button('▶ Run').getBoundingClientRect()
      expect(run.top).toBeGreaterThanOrEqual(0)
      expect(run.bottom).toBeLessThanOrEqual(window.innerHeight)

      button('▶ Run').click()
      await vi.waitFor(() => expect($('.jstep.pass')).not.toBeNull(), { timeout: 20_000 })
      expect($('.jin-form')).toBeNull()
      $('.jin-head')?.click()
      await vi.waitFor(() => expect($('.jin-form .controls-grid')).not.toBeNull())
    })
  })

  it('keeps what was typed while the panel is away, as on the Docs tab', async () => {
    await viewport(1280, 800, async () => {
      show(groups, 'groups-away.seq.ts')
      await ready()
      type(field('traveler2.name') as HTMLInputElement, 'Still Here')
      await tick()
      render(null, root)
      show(groups, 'groups-away.seq.ts')
      await vi.waitFor(() => expect(field('traveler2.name')?.value).toBe('Still Here'))
    })
  })

  it('inputs that cannot be used are said once, under the stop, and the timeline stays as planned', async () => {
    await viewport(1280, 800, async () => {
      show(groups, 'groups-bad.seq.ts', { currency: 'zzz' })
      await ready()
      button('▶ Run').click()
      await vi.waitFor(() => expect($('.jin .error-text')).not.toBeNull(), { timeout: 20_000 })
      expect($('.jin .error-text')?.textContent).toContain('currency')
      expect($$('.jstep')).toHaveLength(1)
      expect($('.seq-right .seq-inputs')).not.toBeNull()
    })
  })
})
