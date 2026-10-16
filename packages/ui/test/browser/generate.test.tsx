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

const generated = sequence({
  id: 'gen-demo',
  title: 'Generated inputs',
  inputs: {
    fullName: c.text({ default: () => faker.person.fullName(), description: 'The customer.' }),
    email: c.text({ default: () => faker.internet.email() }),
    quantity: c.number({ default: 1, min: 1 }),
  },
}).step('Look it up', look)

const asking = sequence({ id: 'ask-demo', title: 'Asks mid-flow' })
  .step('Look it up', look)
  .input('Choose a size', () => ({ size: c.select(['small', 'large'] as const, { default: 1 }) }))
  .step('Look again', look)

describe('generated inputs and running on defaults', () => {
  let root: HTMLElement
  beforeEach(() => {
    root = document.createElement('div')
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
  const value = (name: string) => ($(`input[aria-label="${name}"]`) as HTMLInputElement).value
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes(text),
    ) as HTMLButtonElement

  it('starts a text input from a generated value, which can be edited or generated again', async () => {
    render(<SequencePanel info={{ file: 'gen-demo.seq.ts', seq: generated }} />, root)
    await vi.waitFor(() => expect(value('fullName')).not.toBe(''), { timeout: 20_000 })
    const first = value('fullName')

    // typing is kept; the generator is only asked when someone presses its button
    const input = $('input[aria-label="fullName"]') as HTMLInputElement
    input.value = 'Ada Lovelace'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(value('fullName')).toBe('Ada Lovelace'))

    ;($('button[aria-label="Generate fullName"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(value('fullName')).not.toBe('Ada Lovelace'))
    expect(value('fullName')).not.toBe('')
    expect(value('fullName')).not.toBe(first)
    // only the generated inputs have the button
    expect($('button[aria-label="Generate quantity"]')).toBeNull()
  })

  it('makes every generated input again with Generate all, and only when there are several', async () => {
    render(<SequencePanel info={{ file: 'gen-demo.seq.ts', seq: generated }} />, root)
    await vi.waitFor(() => expect(value('email')).not.toBe(''), { timeout: 20_000 })
    const before = [value('fullName'), value('email')]
    button('Generate all').click()
    await vi.waitFor(() => expect([value('fullName'), value('email')]).not.toEqual(before))
    expect(value('fullName')).not.toBe(before[0])
    expect(value('email')).not.toBe(before[1])
    render(null, root)

    const one = sequence({
      id: 'one',
      title: 'One',
      inputs: { fullName: c.text({ default: () => faker.person.fullName() }) },
    }).step('Look it up', look)
    render(<SequencePanel info={{ file: 'one.seq.ts', seq: one }} />, root)
    await vi.waitFor(() => expect($('button[aria-label="Generate fullName"]')).not.toBeNull(), {
      timeout: 20_000,
    })
    expect(button('Generate all')).toBeUndefined()
  })

  it('a fixed seed makes the generated values repeatable', async () => {
    seed.value = 42
    render(<SequencePanel info={{ file: 'gen-demo.seq.ts', seq: generated }} />, root)
    await vi.waitFor(() => expect(value('fullName')).not.toBe(''), { timeout: 20_000 })
    const first = value('fullName')
    render(null, root)
    render(<SequencePanel info={{ file: 'gen-demo-2.seq.ts', seq: generated }} />, root)
    await vi.waitFor(() => expect(value('fullName')).not.toBe(''), { timeout: 20_000 })
    expect(value('fullName')).toBe(first)
  })

  it('Run with defaults skips the question a flow asks, where Run waits for an answer', async () => {
    render(<SequencePanel info={{ file: 'ask-demo.seq.ts', seq: asking }} />, root)
    ;(await vi.waitFor(() => button('▶ Run'), { timeout: 20_000 })).click()
    await vi.waitFor(() => expect($('.pause')).not.toBeNull(), { timeout: 20_000 })
    render(null, root)

    render(<SequencePanel info={{ file: 'ask-demo-2.seq.ts', seq: asking }} />, root)
    ;(await vi.waitFor(() => button('Run with defaults'), { timeout: 20_000 })).click()
    await vi.waitFor(() => expect($('.seq-run .badge')?.textContent).toContain('Passed'), {
      timeout: 20_000,
    })
    expect($('.pause')).toBeNull()
  })

  it('offers Run with defaults only to a flow that has inputs', async () => {
    const plain = sequence({ id: 'plain', title: 'Plain' }).step('Look it up', look)
    render(<SequencePanel info={{ file: 'plain.seq.ts', seq: plain }} />, root)
    await vi.waitFor(() => expect(button('▶ Run')).toBeDefined(), { timeout: 20_000 })
    expect(button('Run with defaults')).toBeUndefined()
  })

  it('fits a phone: the button and both run buttons are reachable and the page does not scroll sideways', async () => {
    const [w, h] = [window.innerWidth, window.innerHeight]
    await page.viewport(390, 844)
    try {
      render(<SequencePanel info={{ file: 'gen-demo.seq.ts', seq: generated }} />, root)
      await vi.waitFor(() => expect(value('fullName')).not.toBe(''), { timeout: 20_000 })
      const gen = $('button[aria-label="Generate fullName"]') as HTMLButtonElement
      const box = gen.getBoundingClientRect()
      expect(box.width).toBeGreaterThanOrEqual(28)
      expect(box.height).toBeGreaterThanOrEqual(28)
      expect(box.right).toBeLessThanOrEqual(window.innerWidth)
      // the value cell beside it still has room to type
      const cell = $('input[aria-label="fullName"]') as HTMLInputElement
      expect(cell.getBoundingClientRect().width).toBeGreaterThan(80)
      for (const label of ['▶ Run', 'Run with defaults', 'Generate all']) {
        const r = button(label).getBoundingClientRect()
        expect(r.width, label).toBeGreaterThan(0)
        expect(r.left, label).toBeGreaterThanOrEqual(0)
        expect(r.right, label).toBeLessThanOrEqual(window.innerWidth)
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
    } finally {
      await page.viewport(w, h)
    }
  })
})
