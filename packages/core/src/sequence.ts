import type { Controls, InferControls } from './controls'
import type { Assert, AssertMode, AuthProfileName, RequestDef } from './types'

export interface StepCtx<P, C> {
  inputs: P
  captured: C
  vars: Record<string, unknown>
  env: string
}

type StepDef<P, C, C2> =
  | RequestDef<any, any, C2>
  | ((ctx: StepCtx<P, C>) => RequestDef<any, any, C2>)

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

export function sequence<P extends Controls = {}>(
  meta: Omit<SequenceMeta, 'inputs'> & { inputs?: P },
): Sequence<InferControls<P>, {}> {
  return build(meta, [])
}
