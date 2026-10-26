// A script is a unit of author code with a contract, used as a step of a flow: input controls go in, a plain object
// comes out. It is modelled on a request (`with`, `withMock`, `capture`, `assert`, `tags`, `safe`): what it returns is the
// type of its body, the mock environment answers with what `withMock` returns and never runs the body, and `--safe`
// polices the body's fetches.
// Nothing here touches the DOM or Node: the host that runs a flow (the browser UI, the CLI) supplies `ScriptHost`.

import type { Controls, InferControls } from './controls'
import type { Assert, AssertMode } from './types'

/**
 * An element of the page: `HTMLElement` when the project's types include the DOM, and a plain object when they do not (core
 * names no DOM type itself, so a project without the DOM library still compiles).
 */
export type PageElement = typeof globalThis extends { HTMLElement: { prototype: infer E } }
  ? E
  : object

/** Where a script can run: a page, node, or both. A script that needs a browser is skipped, with its flow, in node. */
export type ScriptRuntime = 'browser' | 'node' | 'isomorphic'

/** The body of a script: what runs when its step does. */
export type ScriptBody<In, O> = (inputs: In, h: ScriptHelpers) => O | Promise<O>

/** How `loadScript` loads a file. */
export interface ScriptLoadOptions {
  /** The global the file defines, which is returned. */
  global?: string
  /** The file's hash; the file is refused when it does not match. */
  integrity?: string
  /**
   * `true` (the default) loads a file one time per address, for the page's life or for one test run, however many runs ask
   * for it. `false` fetches and runs the file again on this call; it never reads or fills that one-time record.
   */
  once?: boolean
}

/** What a body is given besides its inputs. */
export interface ScriptHelpers {
  /** `fetch`, from the host: in a page it goes through the browser extension when a site needs it. */
  fetch: typeof fetch
  /** Loads a script file from an address and returns the global it defines (`global`), checked against `integrity` when given. One time per address unless `once` is `false`. */
  loadScript<T = unknown>(url: string, o?: ScriptLoadOptions): Promise<T>
  /** A container in the step's row of the flow panel, for an SDK to render into. Throws where there is no page. */
  mount(): Promise<PageElement>
  /** Ends when the person presses Stop or the script's time limit passes. */
  signal: AbortSignal
  env: string
  vars: Record<string, unknown>
  /** Shown with the step and kept in its result. Never log a token. */
  log(message: string): void
  runtime: 'browser' | 'node'
}

/** What a host gives the runner so scripts can run: the kind of host it is and the few things only it can do. */
export interface ScriptHost {
  runtime: 'browser' | 'node'
  fetch: typeof fetch
  loadScript?: (url: string, o?: ScriptLoadOptions) => Promise<unknown>
  /** Makes the container `ScriptHelpers.mount` returns. Only a host with a page has one. */
  mount?(name: string, signal?: AbortSignal): Promise<PageElement>
}

interface ScriptBase<I extends Controls, O extends Record<string, unknown>, C> {
  /** Names the script in reports and in the docs. */
  id: string
  /** The title in the catalog and in reports; the id when not given. */
  name?: string
  description?: string
  /** Selects it with `specbook test --tag` and groups it in the catalog. */
  tags?: string[]
  /** Where it can run; anywhere unless it says `browser` or `node`. */
  runtime?: ScriptRuntime
  /** Its fetches only read: allowed in a `--safe` run. */
  safe?: boolean
  /** How long the body may take, in milliseconds. In node the run's time limit applies when this is not set; in a page a script waiting for a person has no limit unless it says so. */
  timeoutMs?: number
  inputs?: I
  capture?: { [K in keyof C]: (out: NoInfer<O>, vars: Record<string, unknown>) => C[K] }
  assert?: (
    out: NoInfer<O>,
    ctx: { assert: Assert; vars: Record<string, unknown>; inputs: InferControls<I> },
  ) => void | Promise<void>
  assertMode?: AssertMode
}

/**
 * What `script()` takes: the body inline (`run`) or loaded when the step runs (`load: () => import('./x.browser')`, a file
 * that exports `run`), never both. A body and a loader are both functions, so the two have their own names.
 *
 * The inputs come from `inputs` (`NoInfer` makes the body a check there) and the output is what the body returns, inline
 * or in the loaded file. `capture`, `assert` and `withMock` are checked against it.
 */
export type ScriptInput<I extends Controls, O extends Record<string, unknown>, C> = ScriptBase<
  I,
  O,
  C
> &
  (
    | { run: ScriptBody<NoInfer<InferControls<I>>, O>; load?: never }
    | {
        load: () => Promise<{ run: ScriptBody<NoInfer<InferControls<I>>, O> }>
        run?: never
      }
  )

/** How the mock environment answers a script: return the answer, wait with `delayMs`, or throw to fail the step. */
export type ScriptMockHook<I extends Controls, O> = (
  req: { inputs: InferControls<I>; vars: Record<string, unknown> },
  res: { delayMs: number },
) => O | Promise<O>

export interface ScriptMeta {
  id: string
  name?: string
  description?: string
  tags: string[]
  runtime: ScriptRuntime
  safe: boolean
  timeoutMs?: number
}

/** A string that holds a `{{placeholder}}`: rendered when the step runs, so it may stand for a value of any type. */
type Placeholder = `${string}{{${string}}}${string}`

/** What a control may be given: its value, or a placeholder for it (a whole-string placeholder keeps the value's type). */
export type Given<T> = T extends string
  ? T | Placeholder
  : T extends number | boolean | null | undefined
    ? T | Placeholder
    : T extends readonly (infer U)[]
      ? Given<U>[] | Placeholder
      : T extends object
        ? { [K in keyof T]: Given<T[K]> } | Placeholder
        : T

/** What `.with()` changes for one step. */
export interface ScriptOverrides<I extends Controls, O extends Record<string, unknown>> {
  /** Values for the controls; a whole-string `{{placeholder}}` takes the value of a variable, with its type. */
  inputs?: { [K in keyof InferControls<I>]?: Given<InferControls<I>[K]> }
  /** Added to the script's own tags. */
  tags?: string[]
  assertMode?: AssertMode
  /** Replaces the script's own `assert` for this step. */
  assert?: ScriptBase<I, O, any>['assert']
}

export interface ScriptDef<
  I extends Controls = Controls,
  O extends Record<string, unknown> = Record<string, unknown>,
  /** What the step captures: what the `capture` map returns, else the output itself. */
  C = O,
> {
  readonly kind: 'script'
  readonly meta: ScriptMeta
  readonly inputs: I
  /** The body or its loader, as given. Exactly one is set. Parameters were checked by `script()`, so these are loose. */
  readonly run?: ScriptBody<any, any>
  readonly load?: () => Promise<{ run: ScriptBody<any, any> }>
  readonly capture?: Record<string, (out: any, vars: Record<string, unknown>) => unknown>
  readonly assert?: (
    out: any,
    ctx: { assert: Assert; vars: Record<string, unknown>; inputs: any },
  ) => void | Promise<void>
  readonly assertMode?: AssertMode
  /** `.with({ inputs })`: values or templates for the controls. */
  readonly given: Readonly<Record<string, unknown>>
  /** Set by `withMock`: what the mock environment answers. */
  readonly mockHook?: ScriptMockHook<any, any>
  /** Phantom: lets a flow's `.step()` infer what the step captures, as it does for a request. */
  readonly _captured?: C
  with(o: ScriptOverrides<I, O>): ScriptDef<I, O, C>
}

const RUNTIMES: readonly ScriptRuntime[] = ['browser', 'node', 'isomorphic']

type State = Omit<ScriptDef<any, any, any>, 'with' | '_captured'>

function make<I extends Controls, O extends Record<string, unknown>, C>(
  state: State,
): ScriptDef<I, O, C> {
  return {
    ...state,
    with(o) {
      return make<I, O, C>({
        ...state,
        meta: o.tags
          ? { ...state.meta, tags: [...new Set([...state.meta.tags, ...o.tags])] }
          : state.meta,
        given: o.inputs ? { ...state.given, ...o.inputs } : state.given,
        assert: o.assert ?? state.assert,
        assertMode: o.assertMode ?? state.assertMode,
      })
    },
  } as ScriptDef<I, O, C>
}

/**
 * A step that is not a request: code with typed inputs and a typed output.
 *
 *     export default script({
 *       id: 'card-fingerprint',
 *       name: 'Card fingerprint',
 *       runtime: 'isomorphic',
 *       inputs: { cardNumber: c.text() },
 *       run: async ({ cardNumber }) => ({ fingerprint: await sha256(cardNumber) }),
 *     })
 *
 * What the body returns is the script's output, and `withMock` returns what the mock environment answers.
 * A body that needs a browser goes in its own file, loaded when the step runs: `load: () => import('./x.browser')`,
 * where the file has `export const run: ScriptBody<Inputs, Output> = ...`.
 */
export function script<
  I extends Controls = {},
  O extends Record<string, unknown> = {},
  C = unknown,
>(def: ScriptInput<I, O, C>): ScriptDef<I, O, unknown extends C ? O : C> {
  const where = typeof def.id === 'string' && def.id ? `script "${def.id}"` : 'a script'
  if (typeof def.id !== 'string' || !def.id) throw new Error('A script needs an id.')
  if (def.name !== undefined && typeof def.name !== 'string')
    throw new Error(`${where} has a name that is not text.`)
  if ((def.run === undefined) === (def.load === undefined))
    throw new Error(
      `${where} needs a body: give \`run\` (inline) or \`load\` (loaded when the step runs), not both.`,
    )
  const runtime = def.runtime ?? 'isomorphic'
  if (!RUNTIMES.includes(runtime))
    throw new Error(`${where} has runtime "${String(runtime)}": use browser, node or isomorphic.`)
  return make<I, O, unknown extends C ? O : C>({
    kind: 'script',
    meta: {
      id: def.id,
      name: def.name || undefined,
      description: def.description,
      tags: def.tags ?? [],
      runtime,
      safe: def.safe === true,
      timeoutMs: def.timeoutMs,
    },
    inputs: (def.inputs ?? {}) as I,
    run: def.run as ScriptBody<any, any> | undefined,
    load: def.load as (() => Promise<{ run: ScriptBody<any, any> }>) | undefined,
    capture: def.capture as State['capture'],
    assert: def.assert as State['assert'],
    assertMode: def.assertMode,
    given: {},
  })
}

/** Sets how the mock environment answers a script (used by `withMock`, which also takes a request). */
export function withScriptMock<I extends Controls, O extends Record<string, unknown>, C>(
  def: ScriptDef<I, O, C>,
  hook: ScriptMockHook<I, NoInfer<O>>,
): ScriptDef<I, O, C> {
  const { with: _with, _captured, ...state } = def
  return make<I, O, C>({ ...state, mockHook: hook as ScriptMockHook<any, any> })
}
