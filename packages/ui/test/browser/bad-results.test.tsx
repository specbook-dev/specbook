import { defineOperation, sequence, withMock } from '@specbook/core'
import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Panel } from '../../src/panel/Panel'
import { SequencePanel } from '../../src/panel/SequencePanel'
import { env } from '../../src/store'
import 'prism-code-editor/layout.css'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'
import '../../src/styles/panel.css'

/**
 * A run is whatever the API answered and whatever the project's code did with it, and the panel draws that. None of it may
 * stop the panel: the run finishes, its step is there to open, and what went wrong is said in words.
 */

const Get = defineOperation<{
  params: { path: { orderId: number } }
  body: never
  responses: { 200: { id: number } }
}>({ service: 'petstore', id: 'GetOrderById', method: 'GET', path: '/store/order/{orderId}' })

const circular = () => {
  const a: Record<string, unknown> = {}
  a.self = a
  return a
}

/** A flow of one request whose answer the mock hook makes, and whose capture is the project's own. */
const flowOf = (answer: (res: { data: unknown }) => void, capture: (res: any) => unknown) =>
  sequence({ id: 'odd', title: 'Odd' }).step(
    'Place order',
    withMock(
      Get.request({ path: { orderId: 5 }, capture: { orderId: capture } } as never),
      (_req, res) => answer(res as never),
    ),
  )

const cases: [string, ReturnType<typeof flowOf>][] = [
  [
    'an answer with no body, and a capture of undefined',
    flowOf(
      (r) => {
        r.data = undefined
      },
      () => undefined,
    ),
  ],
  [
    'null, read as if it were an order',
    flowOf(
      (r) => {
        r.data = null
      },
      (res) => res.data.id,
    ),
  ],
  [
    'a list where an order was promised',
    flowOf(
      (r) => {
        r.data = [1, 2, 3]
      },
      (res) => res.data.id,
    ),
  ],
  [
    'a capture that cannot be written as json',
    flowOf(
      () => {},
      () => circular(),
    ),
  ],
  [
    'a capture that is a BigInt',
    flowOf(
      () => {},
      () => BigInt(5),
    ),
  ],
  [
    'a capture that is a function',
    flowOf(
      () => {},
      () => () => 1,
    ),
  ],
  [
    'a capture that throws',
    flowOf(
      () => {},
      () => {
        throw new Error('no such field')
      },
    ),
  ],
]

describe('the panel, whatever a run returns', () => {
  let root: HTMLElement
  beforeEach(() => {
    root = document.createElement('div')
    document.body.append(root)
    env.value = 'mock'
  })
  afterEach(() => {
    render(null, root)
    document.body.innerHTML = ''
  })
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T | null

  it.each(cases)('finishes, and draws its step, for %s', async (_name, seq) => {
    const errors: string[] = []
    const onError = (e: ErrorEvent) => errors.push(e.message)
    window.addEventListener('error', onError)
    render(<SequencePanel info={{ file: 'odd.seq.ts', seq }} />, root)
    ;(
      await vi.waitFor(() => $('.seq-run .btn.primary') as HTMLButtonElement, { timeout: 20_000 })
    ).click()
    // the run ends: the button is a Run button again, and the summary badge is there
    await vi.waitFor(() => expect($('.seq-run .badge')).not.toBeNull(), { timeout: 20_000 })
    expect($('.seq-run .btn.primary')?.textContent).not.toContain('Running')
    expect($('.jstep')).not.toBeNull()
    // the safety net did not have to catch anything: the step was drawn
    expect($('.panel-error')).toBeNull()
    // and the step opens
    ;($('.jhead') as HTMLButtonElement).click()
    await vi.waitFor(() => expect($('.seq-right')).not.toBeNull())
    expect($('.panel-error')).toBeNull()
    window.removeEventListener('error', onError)
    expect(errors).toEqual([])
  })

  it('says so in words, and stays usable, when drawing something fails after all', async () => {
    const Boom = () => {
      throw new Error('could not be drawn')
    }
    const closed = vi.fn()
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <Panel title="Odd" onClose={closed} modal={false}>
        <Boom />
      </Panel>,
      root,
    )
    await vi.waitFor(() => expect($('.panel-error')).not.toBeNull())
    expect($('.panel-error')?.textContent).toContain('This could not be shown')
    expect($('.panel-error')?.textContent).toContain('could not be drawn')
    // the panel around it still works
    ;(root.querySelector('[aria-label="Close panel"]') as HTMLButtonElement).click()
    quiet.mockRestore()
    expect(closed).toHaveBeenCalled()
  })
})
