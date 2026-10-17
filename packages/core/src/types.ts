export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
export type Encoding = 'json' | 'form' | 'multipart' | 'graphql' | 'text' | 'binary' | 'none'

/** Type-level description of an operation. Generated code supplies it as a type argument. */
export interface OpTypes {
  params: { path?: object; query?: object; headers?: object }
  body: unknown
  responses: Record<number, unknown>
}

/** Runtime description of an operation (tiny; generated per operationId). */
export interface OpMeta {
  service: string
  id: string
  method: HttpMethod
  path: string // '/orders/{id}'
  encoding?: Encoding
  /** The media type the spec declares for a binary body (never a wildcard); sent as its Content-Type. */
  mediaType?: string
  /** false = spec says no auth required; auth profiles are skipped. */
  security?: boolean
  /** Dotted body paths whose string values are file paths to upload (spec `format: binary`). */
  files?: string[]
  /** Array style per top-level form field, from the spec's `encoding.<field>.style/explode`. */
  formArrays?: Record<string, import('./runner/encode').FormArrays>
}

export type AnyOp = {
  params: { path?: object; query?: object; headers?: object }
  body: any
  responses: Record<number, any>
}

export interface ApiResponse<S extends number, B> {
  status: S
  ok: boolean
  headers: Record<string, string>
  data: B
  text: string
  durationMs: number
}

export type ResponseOf<T extends OpTypes> = {
  [S in keyof T['responses'] & number]: ApiResponse<S, T['responses'][S]>
}[keyof T['responses'] & number]

/** Every leaf may also be a string so JSON templates containing "{{var}}" type-check. */
export type Templated<T> = T extends string
  ? string
  : T extends number | boolean | null | undefined
    ? T | string
    : T extends readonly (infer U)[]
      ? Templated<U>[] | string
      : T extends object
        ? { [K in keyof T]: Templated<T[K]> } | string
        : T

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

export type Source<T> = Templated<T> | (() => Promise<{ default: Templated<T> }>)

export type Init = Record<string, unknown>
export type ResolvedInit<I> = { [K in keyof I]: I[K] extends () => infer R ? R : I[K] }

/** B's keys replace A's: a capture overrides an `init` of the same name. */
export type Merge<A, B> = Omit<A, keyof B> & B

export type AuthProfileName = string

export interface Assert {
  ok(value: unknown, msg?: string): void
  is(actual: unknown, expected: unknown, msg?: string): void
  equal(actual: unknown, expected: unknown, msg?: string): void
  type(actual: unknown, expected: string, msg?: string): void
  instance(actual: unknown, expected: unknown, msg?: string): void
  match(actual: string, expected: string | RegExp, msg?: string): void
  throws(fn: () => unknown, expected?: unknown, msg?: string): void
  not: {
    (value: unknown, msg?: string): void
    ok(value: unknown, msg?: string): void
    equal(actual: unknown, expected: unknown, msg?: string): void
    type(actual: unknown, expected: string, msg?: string): void
    instance(actual: unknown, expected: unknown, msg?: string): void
    match(actual: string, expected: string | RegExp, msg?: string): void
  }
  unreachable(msg?: string): void
}

export type AssertMode = 'soft' | 'hard'

export interface RequestInput<T extends OpTypes, I extends Init = Init, C = {}> {
  name?: string
  /** Name of the example this request starts from; the fields below deep-merge over it. */
  example?: string
  /** Values chosen before the request is sent; functions are evaluated fresh on each run. */
  init?: I
  path?: Templated<T['params']['path']>
  query?: Templated<T['params']['query']>
  headers?: Record<string, string>
  data?: Source<T['body']>
  encoding?: Encoding
  timeoutMs?: number
  /** A request that only reads (a POST search, a GraphQL query): allowed in a read-only run. */
  safe?: boolean
  /** Labels to select this request by (`specbook test --tag monitor`) and to group it by in the UI. */
  tags?: string[]
  capture?: { [K in keyof C]: (res: ResponseOf<T>, vars: ResolvedInit<I>) => C[K] }
  assert?: (
    res: ResponseOf<T>,
    ctx: {
      assert: Assert
      /** Everything in scope for this request plus this step's own captures. */
      vars: Merge<ResolvedInit<I>, C> & Record<string, unknown>
      /** The request as sent (placeholders for secrets and sessions, file descriptors for uploads). */
      req: RenderedRequest
    },
  ) => void | Promise<void>
  auth?: AuthProfileName | false
  assertMode?: AssertMode
}

/** What the request being answered looks like to a mock: its values, as they were sent. */
export interface MockReq<I> {
  vars: ResolvedInit<I> & Record<string, unknown>
  body: unknown
  query: unknown
  path: unknown
  headers: Record<string, string>
}

/**
 * The answer a mock is about to give, one shape per status the operation declares so that checking `res.status` narrows
 * `res.data`. Change `data`, `headers` and `delayMs` in place, or `respond` with another status.
 */
export type MockRes<T extends OpTypes> = {
  [S in keyof T['responses'] & number]: {
    status: S
    data: T['responses'][S]
    headers: Record<string, string>
    /** Wait this long before answering. */
    delayMs: number
    /**
     * Answer with another status the operation declares: its generated example, with `data` merged over it. Request values
     * are echoed into a 2xx example as usual.
     */
    respond<R extends keyof T['responses'] & number>(
      status: R,
      data?: DeepPartial<T['responses'][R]>,
    ): void
  }
}[keyof T['responses'] & number]

/** Runs when the `mock` environment answers this request, after the example is chosen, filled from the request and rendered. */
export type MockHook<T extends OpTypes, I> = (
  req: MockReq<I>,
  res: MockRes<T>,
) => void | Promise<void>

export interface RequestOverrides<T extends OpTypes, I, C2> {
  /** Added to the request's own tags. */
  tags?: string[]
  vars?: Partial<ResolvedInit<I>> & Record<string, unknown>
  path?: Partial<Templated<T['params']['path']>>
  query?: Partial<Templated<T['params']['query']>>
  headers?: Record<string, string>
  data?: DeepPartial<Templated<T['body']>>
  capture?: { [K in keyof C2]: (res: ResponseOf<T>) => C2[K] }
  assert?: RequestInput<T, any, any>['assert']
  auth?: AuthProfileName | false
  assertMode?: AssertMode
}

export interface RequestDef<T extends OpTypes = AnyOp, I extends Init = Init, C = {}> {
  readonly kind: 'request'
  readonly op: OpMeta
  readonly input: RequestInput<T, I, C>
  /** Deep-merge patches applied to the rendered data template, in order. */
  readonly dataPatches: readonly unknown[]
  /** Explicit `.with({ vars })`; beats captures and inputs, only UI overrides are higher. */
  readonly varOverrides: Readonly<Record<string, unknown>>
  /** Set by `withMock`: how the mock environment answers this request. */
  readonly mockHook?: MockHook<T, I>
  /** Phantom: lets sequence steps infer the captured type. */
  readonly _captured?: C
  with<C2 = {}>(o: RequestOverrides<T, I, C2>): RequestDef<T, I, C & C2>
}

export interface Operation<T extends OpTypes = AnyOp> {
  readonly meta: OpMeta
  request<I extends Init = {}, C = {}>(input?: RequestInput<T, I, C>): RequestDef<T, I, C>
}

export interface AssertionResult {
  label: string
  operator: string
  pass: boolean
  actual?: unknown
  expected?: unknown
  diff?: string
  location?: { file: string; line: number; column?: number }
}

export interface RenderedRequest {
  method: HttpMethod
  service: string
  /** the operation's id, so a result can be tied back to its schemas */
  opId?: string
  url: string
  query: Record<string, string | string[]>
  headers: Record<string, string>
  body?: unknown
  profile?: string
}

/** Where a placeholder's value came from, highest precedence first. */
export interface VarUse {
  key: string
  source: 'override' | 'capture' | 'input' | 'init' | 'config'
  /** Step that produced it, for captures. */
  step?: string
  /** A capture replaced a value of another type (e.g. a string id in an integer slot). */
  shadows?: { source: VarUse['source']; type: string; replacedBy: string }
}

export interface StepResult {
  name: string
  kind: 'request' | 'each' | 'input' | 'check' | 'auth'
  status: 'pass' | 'fail' | 'error' | 'skipped'
  request?: RenderedRequest
  /** Placeholders the request used and where each value came from. */
  uses?: VarUse[]
  response?: { status: number; headers: Record<string, string>; body: unknown; durationMs: number }
  assertions: AssertionResult[]
  captured: Record<string, unknown>
  error?: string
  durationMs: number
  children?: StepResult[]
}

export interface RunResult {
  schemaVersion: 1
  runId: string
  kind: 'request' | 'sequence'
  id: string
  title: string
  env: string
  locale?: string
  seed?: number
  usedDrafts: boolean
  tags: string[]
  /** The project file the request or flow comes from, relative to the project; set by the CLI. */
  file?: string
  /** How many times it was run when retries were allowed (1 = no retry); set by the CLI. */
  attempts?: number
  /** It failed, then passed on a retry; set by the CLI. */
  flaky?: boolean
  status: 'pass' | 'fail' | 'error'
  startedAt: string
  durationMs: number
  totals: {
    steps: number
    passed: number
    failed: number
    skipped: number
    assertions: { passed: number; failed: number }
  }
  steps: StepResult[]
}
