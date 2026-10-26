import type { Controls, InferControls } from './controls'
import type { ScriptDef } from './script'
import type { Assert, AssertMode, AuthProfileName, RequestDef } from './types'

export interface StepCtx<P, C> {
  inputs: P
  captured: C
  vars: Record<string, unknown>
  env: string
}

/** A step is a request or a script, given as it is or made from what the flow has so far. */
type StepDef<P, C, C2> =
  | RequestDef<any, any, C2>
  | ScriptDef<any, any, C2>
  | ((ctx: StepCtx<P, C>) => RequestDef<any, any, C2> | ScriptDef<any, any, C2>)

export type StepNode =
  | { kind: 'step'; name: string; def: StepDef<any, any, any> }
  | {
      kind: 'each'
      name: string
      items: (ctx: StepCtx<any, any>) => unknown[]
      def: (item: any, ctx: StepCtx<any, any>, i: number) => RequestDef<any, any, any>
    }
  | { kind: 'input'; name: string; controls: (ctx: StepCtx<any, any>) => Controls }
  | {
      kind: 'check'
      name: string
      fn: (ctx: StepCtx<any, any>, h: { assert: Assert }) => void | Promise<void>
    }

export interface SequenceMeta {
  id: string
  title: string
  description?: string
  tags?: string[]
  /** Heading the flow is listed under in the catalog; flows without one are under "Default". */
  group?: string
  inputs?: Controls
  auth?: AuthProfileName | false
  assertMode?: AssertMode
  continueOnFailure?: boolean
}

export interface Sequence<P = {}, C = {}> {
  readonly kind: 'sequence'
  readonly meta: SequenceMeta
  readonly nodes: readonly StepNode[]
  step<C2 = {}>(name: string, def: StepDef<P, C, C2>): Sequence<P, C & C2>
  each<T, C2 = {}>(
    name: string,
    items: (ctx: StepCtx<P, C>) => T[],
    def: (item: T, ctx: StepCtx<P, C>, i: number) => RequestDef<any, any, C2>,
  ): Sequence<P, C & { [K in keyof C2]: C2[K][] }>
  use<C2>(other: Sequence<any, C2>): Sequence<P, C & C2>
  check(
    name: string,
    fn: (ctx: StepCtx<P, C>, h: { assert: Assert }) => void | Promise<void>,
  ): Sequence<P, C>
  /** Pause for user input; the chosen values merge into ctx.inputs. */
  input<R extends Controls>(
    name: string,
    controls: (ctx: StepCtx<P, C>) => R,
  ): Sequence<P & InferControls<R>, C>
}

function build(meta: SequenceMeta, nodes: readonly StepNode[]): Sequence<any, any> {
  const add = (n: StepNode) => build(meta, [...nodes, n])
  return {
    kind: 'sequence',
    meta,
    nodes,
    step: (name, def) => add({ kind: 'step', name, def }),
    each: (name, items, def) => add({ kind: 'each', name, items, def }),
    use: (other) => build(meta, [...nodes, ...other.nodes]),
    check: (name, fn) => add({ kind: 'check', name, fn }),
    input: (name, controls) => add({ kind: 'input', name, controls }),
  }
}

/**
 * What the flow's scripts need that a request does not: `browser` or `node`, `both` when it has one of each (it can
 * only run on `mock`), nothing when it has no script or every script is isomorphic. Only steps given as they are
 * count: a step made by a function is known when it runs.
 */
export function flowRuntime(seq: Sequence<any, any>): 'browser' | 'node' | 'both' | undefined {
  const need = new Set<string>()
  for (const n of seq.nodes) {
    if (n.kind !== 'step' || typeof n.def === 'function' || n.def.kind !== 'script') continue
    if (n.def.meta.runtime !== 'isomorphic') need.add(n.def.meta.runtime)
  }
  if (need.size === 0) return undefined
  return need.size > 1 ? 'both' : (need.values().next().value as 'browser' | 'node')
}

export const SKIP_REASONS = {
  browser: 'Needs a browser: run this flow in the portal.',
  node: 'Needs node: run this flow with specbook test or a bundle.',
  both: 'Has a step that needs a browser and one that needs node: it only runs on mock.',
  none: 'This run has no script host: a script cannot run here.',
} as const

/** Why a script step will not run on this host (no runtime = no host), or undefined when it will. */
export function scriptSkipReason(
  def: ScriptDef<any, any, any>,
  runtime: 'browser' | 'node' | undefined,
): string | undefined {
  if (!runtime) return SKIP_REASONS.none
  if (def.meta.runtime === 'isomorphic' || def.meta.runtime === runtime) return undefined
  return SKIP_REASONS[def.meta.runtime]
}

/** Why a flow will not run on this host, or undefined when it will. The mock environment answers every script. */
export function flowSkipReason(
  seq: Sequence<any, any>,
  runtime: 'browser' | 'node' | undefined,
  env: string,
): string | undefined {
  if (env === 'mock') return undefined
  if (!runtime) {
    const has = seq.nodes.some(
      (n) => n.kind === 'step' && typeof n.def !== 'function' && n.def.kind === 'script',
    )
    return has ? SKIP_REASONS.none : undefined
  }
  const need = flowRuntime(seq)
  return !need || need === runtime ? undefined : SKIP_REASONS[need]
}

/** A script as a flow of one step, so it is listed, run, embedded and reported like a flow. */
export function scriptFlow(def: ScriptDef<any, any, any>): Sequence<any, any> {
  const title = def.meta.name ?? def.meta.id
  const given = Object.fromEntries(Object.keys(def.inputs).map((k) => [k, `{{${k}}}`]))
  return sequence({
    id: def.meta.id,
    title,
    description: def.meta.description,
    tags: def.meta.tags,
    inputs: def.inputs,
  }).step(title, def.with({ inputs: given as any }))
}

export function sequence<P extends Controls = {}>(
  meta: Omit<SequenceMeta, 'inputs'> & { inputs?: P },
): Sequence<InferControls<P>, {}> {
  return build(meta, [])
}
