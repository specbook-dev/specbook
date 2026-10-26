import type { Controls } from './controls'
import { type ScriptDef, type ScriptMockHook, withScriptMock } from './script'
import { deepMerge } from './template'
import type {
  AnyOp,
  Init,
  MockHook,
  Operation,
  OpMeta,
  OpTypes,
  RequestDef,
  RequestInput,
  RequestOverrides,
} from './types'

function make<T extends OpTypes, I extends Init, C>(
  op: OpMeta,
  input: RequestInput<T, I, C>,
  dataPatches: readonly unknown[],
  varOverrides: Readonly<Record<string, unknown>> = {},
  mockHook?: MockHook<T, I>,
): RequestDef<T, I, C> {
  return {
    kind: 'request',
    op,
    input,
    dataPatches,
    varOverrides,
    mockHook,
    with<C2>(o: RequestOverrides<T, I, C2>) {
      const next: RequestInput<T, any, any> = { ...input }
      if (o.path) next.path = deepMerge(input.path as any, o.path) as any
      if (o.query) next.query = deepMerge(input.query as any, o.query) as any
      if (o.headers) next.headers = { ...(input.headers ?? {}), ...o.headers }
      if (o.capture) next.capture = { ...(input.capture ?? {}), ...o.capture } as any
      if (o.assert) next.assert = o.assert
      if (o.auth !== undefined) next.auth = o.auth
      if (o.assertMode) next.assertMode = o.assertMode
      if (o.tags) next.tags = [...new Set([...(input.tags ?? []), ...o.tags])]
      const patches = o.data !== undefined ? [...dataPatches, o.data] : dataPatches
      const overrides = o.vars ? { ...varOverrides, ...o.vars } : varOverrides
      return make(op, next, patches, overrides, mockHook) as RequestDef<T, I, C & C2>
    },
  }
}

/**
 * How the `mock` environment answers this request, when the generated example (filled from the request) is not enough.
 * Rarely needed; `req` and `res` are typed from the operation. Returns the request, so it is the file's one export:
 *
 *     export default withMock(GetOrder.request({ ... }), (req, res) => {
 *       if (res.status === 200) res.data.status = 'placed'
 *     })
 */
export function withMock<T extends OpTypes, I extends Init, C>(
  def: RequestDef<T, I, C>,
  hook: MockHook<T, I>,
): RequestDef<T, I, C>
/** The same for a script: the hook returns what the mock environment answers, typed from the script's body. */
export function withMock<I extends Controls, O extends Record<string, unknown>, C>(
  def: ScriptDef<I, O, C>,
  hook: ScriptMockHook<I, NoInfer<O>>,
): ScriptDef<I, O, C>
export function withMock(
  def: RequestDef<any, any, any> | ScriptDef<any, any, any>,
  hook: MockHook<any, any> | ScriptMockHook<any, any>,
): RequestDef<any, any, any> | ScriptDef<any, any, any> {
  if (def.kind === 'script') return withScriptMock(def, hook as ScriptMockHook<any, any>)
  return make(def.op, def.input, def.dataPatches, def.varOverrides, hook as MockHook<any, any>)
}

/** Generated code calls this once per operation. */
export function defineOperation<T extends OpTypes = AnyOp>(meta: OpMeta): Operation<T> {
  return {
    meta,
    request<I extends Init = {}, C = {}>(input: RequestInput<T, I, C> = {}) {
      return make<T, I, C>(meta, input, [])
    },
  }
}

/** Untyped escape hatch for endpoints without a spec. */
export function request<I extends Init = {}, C = {}>(
  input: RequestInput<AnyOp, I, C> & {
    method: OpMeta['method']
    url: string
    service?: string
  },
): RequestDef<AnyOp, I, C> {
  const { method, url, service, ...rest } = input
  const meta: OpMeta = {
    service: service ?? 'default',
    id: `${method} ${url}`,
    method,
    path: url,
  }
  return make<AnyOp, I, C>(meta, rest as RequestInput<AnyOp, I, C>, [])
}
