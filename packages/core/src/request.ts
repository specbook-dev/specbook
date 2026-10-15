import { deepMerge } from './template'
import type {
  AnyOp,
  Init,
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
): RequestDef<T, I, C> {
  return {
    kind: 'request',
    op,
    input,
    dataPatches,
    varOverrides,
    with<C2>(o: RequestOverrides<T, I, C2>) {
      const next: RequestInput<T, any, any> = { ...input }
      if (o.path) next.path = deepMerge(input.path as any, o.path) as any
      if (o.query) next.query = deepMerge(input.query as any, o.query) as any
      if (o.headers) next.headers = { ...(input.headers ?? {}), ...o.headers }
      if (o.capture) next.capture = { ...(input.capture ?? {}), ...o.capture } as any
      if (o.assert) next.assert = o.assert
      if (o.mock) next.mock = { ...(input.mock ?? {}), ...o.mock } as any
      if (o.auth !== undefined) next.auth = o.auth
      if (o.assertMode) next.assertMode = o.assertMode
      const patches = o.data !== undefined ? [...dataPatches, o.data] : dataPatches
      const overrides = o.vars ? { ...varOverrides, ...o.vars } : varOverrides
      return make(op, next, patches, overrides) as RequestDef<T, I, C & C2>
    },
  }
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
