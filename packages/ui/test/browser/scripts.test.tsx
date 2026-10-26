import { c, type Sequence, script, scriptFlow, sequence, withMock } from '@specbook/core'
import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { SequencePanel } from '../../src/panel/SequencePanel'
import { env } from '../../src/store'
import 'prism-code-editor/layout.css'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'
import '../../src/styles/panel.css'

/** A script step renders into its own row, ends with Stop, is shown as what it was given and returned, and is left out where it cannot run. */

/** Waits for a person to press its button: what an SDK's "Approve" does. */
const approve = withMock(
  script({
    id: 'approve',
    name: 'Approve',
    runtime: 'browser',
    inputs: { amount: c.number({ default: 10 }) },
    run: async ({ amount }, h) => {
      h.log('showing the button')
      const el = await h.mount()
      const button = document.createElement('button')
      button.textContent = 'Approve payment'
      el.append(button)
      await new Promise<void>((resolve, reject) => {
        button.onclick = () => resolve()
        h.signal?.addEventListener('abort', () => reject(new Error('stopped')))
      })
      return { approvedAt: 'just now', amount }
    },
  }),
  ({ inputs }) => ({ approvedAt: 'mock-time', amount: inputs.amount }),
)

const flow = (def = approve) =>
  sequence({ id: 'pay', title: 'Pay' })
    .step('Approve', def)
    .check('Approved', (ctx, { assert }) => assert.ok(ctx.captured.approvedAt, 'approved'))

describe('script steps in the flow panel', () => {
  let root: HTMLElement
  beforeEach(async () => {
    await page.viewport(1280, 844)
    root = document.createElement('div')
    root.style.cssText = 'width:100%;height:700px'
    document.body.append(root)
    env.value = 'live'
  })
  afterEach(() => {
    render(null, root)
    document.body.innerHTML = ''
    env.value = 'mock'
  })
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T | null
  const $$ = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)]
  const open = (seq: Sequence<any, any>) =>
    render(<SequencePanel info={{ file: `${seq.meta.id}.seq.ts`, seq }} />, root)
  const waitFor = <T,>(f: () => T | null | undefined | false) =>
    vi.waitFor(
      () => {
        const v = f()
        if (!v) throw new Error('not yet')
        return v as T
      },
      { timeout: 20_000 },
    )
  const run = async () =>
    (await waitFor(() => $<HTMLButtonElement>('.seq-run .btn.primary'))).click()
  const badge = () => $('.seq-run .badge')?.textContent ?? ''

  it('renders what the script asks for in its own row, and goes on when the person acts', async () => {
    open(flow())
    await run()
    // the script's container is in the row of its step, which is running
    const button = await waitFor(() => $<HTMLButtonElement>('.jstep.running .script-stage button'))
    expect(button.textContent).toBe('Approve payment')
    expect($$('.script-stage')).toHaveLength(1)
    button.click()
    await waitFor(() => badge().includes('Passed'))
    expect($$('.script-stage')).toHaveLength(0)
    // what it returned is a capture, as for a request
    const chips = $$('.jstep .cap.make').map((e) => e.textContent ?? '')
    expect(chips.join(' ')).toContain('approvedAt')
    expect($$('.jstep.pass')).toHaveLength(2)
  })

  it('runs a script on its own: the form shows its inputs, and the output is captured', async () => {
    const alone = script({
      id: 'alone',
      runtime: 'isomorphic',
      inputs: { amount: c.number({ default: 7, description: 'What is asked.' }) },
      run: async ({ amount }) => ({ doubled: amount * 2 }),
    })
    open(scriptFlow(alone))
    await waitFor(() => $('.seq-run'))
    expect(root.textContent).toContain('What is asked.')
    await run()
    await waitFor(() => badge().includes('Passed'))
    expect(root.textContent).toContain('doubled')
  })

  it('gives the timeline room for a widget of 300px, in a flow with a script and only there', async () => {
    // a panel as wide as the portal's, where the timeline is at its minimum
    root.style.width = '800px'
    const left = () => ($('.seq-left') as HTMLElement).getBoundingClientRect().width
    const plain = sequence({ id: 'plain', title: 'Plain' }).check('Nothing', (_c, { assert }) =>
      assert.ok(true, 'ok'),
    )
    open(plain)
    await waitFor(() => $('.seq-left'))
    expect($('.sequence-panel.has-script')).toBeNull()
    expect(Math.round(left())).toBe(300)
    render(null, root)

    open(flow())
    await run()
    const stage = await waitFor(() =>
      $('.script-stage button')?.closest<HTMLElement>('.script-stage'),
    )
    expect($('.sequence-panel.has-script')).not.toBeNull()
    expect(Math.round(left())).toBe(392)
    // what the stage holds fits: 300px for the widget, and a little for the stage's own padding
    expect(stage.clientWidth).toBeGreaterThanOrEqual(308)
    expect(stage.scrollWidth).toBeLessThanOrEqual(stage.clientWidth)
    ;(await waitFor(() => $<HTMLButtonElement>('.script-stage button'))).click()
    await waitFor(() => badge().includes('Passed'))
    render(null, root)

    // on a phone the timeline is the whole width, and the stage is wide enough there too
    await page.viewport(390, 844)
    root.style.width = '100%'
    open(flow())
    await run()
    const narrow = await waitFor(() =>
      $('.script-stage button')?.closest<HTMLElement>('.script-stage'),
    )
    expect(narrow.clientWidth).toBeGreaterThanOrEqual(308)
    ;(await waitFor(() => $<HTMLButtonElement>('.script-stage button'))).click()
    await waitFor(() => badge().includes('Passed'))
  })

  it('shows the finished step as inputs, output, checks and logs, not as a request', async () => {
    open(flow())
    await run()
    ;(await waitFor(() => $<HTMLButtonElement>('.script-stage button'))).click()
    await waitFor(() => badge().includes('Passed'))
    $$('.jhead')[0]?.click()
    const exchange = await waitFor(() => $('.step-exchange'))
    expect(exchange.querySelector('.rq-bar')?.textContent).toContain('approve')
    expect(exchange.querySelector('.rq-bar')?.textContent).toContain('browser')
    const tabs = [...exchange.querySelectorAll('.rq-tab')].map((t) => t.textContent ?? '')
    expect(tabs.join('|')).toMatch(/Output.*\|Inputs.*\|Checks.*\|Logs/)
    expect(exchange.textContent).not.toContain('Request')
    ;[...exchange.querySelectorAll<HTMLButtonElement>('.rq-tab')]
      .find((t) => t.textContent?.startsWith('Logs'))
      ?.click()
    await waitFor(
      () => exchange.querySelector('.script-logs')?.textContent === 'showing the button',
    )
    ;[...exchange.querySelectorAll<HTMLButtonElement>('.rq-tab')]
      .find((t) => t.textContent?.startsWith('Inputs'))
      ?.click()
    await waitFor(() =>
      /amount\s*10/.test(exchange.querySelector('.tab-pane:not([hidden])')?.textContent ?? ''),
    )
  })

  it('ends a script that is waiting on a person when the run is stopped', async () => {
    open(flow())
    await run()
    await waitFor(() => $('.script-stage button'))
    ;(await waitFor(() => $$('.seq-run .btn').find((b) => b.textContent === 'Stop'))).click()
    await waitFor(() => badge().includes('Stopped'))
    expect($$('.script-stage')).toHaveLength(0)
    const first = $$('.jstep')[0]
    expect(first?.textContent).toContain('Stopped before the step finished.')
    // nothing after it ran
    expect($$('.jstep')[1]?.classList.contains('skipped')).toBe(true)
  })

  it('renders in a shadow root, as the project embed does: the script is handed the element, so no selector is needed', async () => {
    const shadow = root.attachShadow({ mode: 'open' })
    render(<SequencePanel info={{ file: 'pay.seq.ts', seq: flow() }} />, shadow as never)
    try {
      const run = await waitFor(() =>
        shadow.querySelector<HTMLButtonElement>('.seq-run .btn.primary'),
      )
      run.click()
      const button = await waitFor(() =>
        shadow.querySelector<HTMLButtonElement>('.jstep.running .script-stage button'),
      )
      // an SDK that looks for its container by selector on the document would find nothing: it is inside the shadow root
      expect(document.querySelector('.script-stage')).toBeNull()
      expect(document.querySelector('.script-stage button')).toBeNull()
      button.click()
      await waitFor(() => shadow.querySelector('.seq-run .badge')?.textContent?.includes('Passed'))
    } finally {
      render(null, shadow as never)
    }
  })

  it('answers from its mock in the mock environment: no container, no body', async () => {
    env.value = 'mock'
    open(flow())
    await run()
    await waitFor(() => badge().includes('Passed'))
    expect($$('.script-stage')).toHaveLength(0)
    const chips = $$('.jstep .cap.make')
      .map((e) => e.textContent ?? '')
      .join(' ')
    expect(chips).toContain('mock-time')
    expect(chips).toContain('10')
  })

  it('says a flow that needs node is not run here, before and after Run', async () => {
    const onNode = script({
      id: 'sign',
      name: 'Sign',
      runtime: 'node',
      run: async () => ({ signature: 'real' }),
    })
    open(sequence({ id: 'sign-flow', title: 'Sign' }).step('Sign', onNode))
    await waitFor(() => $('.seq-unmet')?.textContent?.includes('Needs node'))
    await run()
    await waitFor(() => badge().includes('Skipped'))
    expect($('.jstep')?.textContent).toContain('Needs node')
    expect($('.seq-run .badge')?.classList.contains('skipped')).toBe(true)
  })

  it('offers the extension when a script’s call is blocked by the browser', async () => {
    const blocked = script({
      id: 'blocked',
      name: 'Blocked',
      runtime: 'browser',
      run: async () => {
        throw Object.assign(new Error('The browser could not reach https://sdk.example.'), {
          hint: { code: 'cors', origin: 'https://sdk.example' },
        })
      },
    })
    open(sequence({ id: 'blocked-flow', title: 'Blocked' }).step('Blocked', blocked))
    await run()
    const nudge = await waitFor(() => $('.step-exchange .ext-nudge'))
    expect(nudge.textContent).toContain('sdk.example')
    expect($('.step-exchange .error-text')?.textContent).toContain('could not reach')
  })
})
