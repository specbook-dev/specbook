import { createAsserter } from '../assert'
import { ControlError, type Controls, describeControls, resolveControls } from '../controls'
import { oauthFor } from '../environment'
import type { Example, ExampleLoader, FileReader } from '../example'
import {
  authServiceName,
  clientCredentialsFields,
  isClientCredentials,
  type OAuthClientCredentials,
  type OAuthSettings,
  parseTokenResponse,
} from '../oauth'
import type { ScriptDef, ScriptHelpers, ScriptHost } from '../script'
import { MissingSecretsError, maskDeep } from '../secrets'
import {
  flowSkipReason,
  type Sequence,
  type StepCtx,
  type StepNode,
  scriptSkipReason,
} from '../sequence'
import {
  collectPlaceholders,
  deepMerge,
  isDeferred,
  isFakerName,
  isPlainObject,
  render,
  rootName,
} from '../template'
import type {
  ApiResponse,
  AssertionResult,
  AssertMode,
  OpMeta,
  RenderedRequest,
  RequestDef,
  RunResult,
  StepResult,
  VarUse,
} from '../types'
import { type ProfileReason, resolveProfile } from './auth'
import { describeFiles, isBlob } from './encode'
import {
  DEFAULT_TIMEOUT_MS,
  type PreparedRequest,
  type RawResponse,
  type Transport,
} from './transport'

// ---------------- public options ----------------

export interface Session {
  accessToken: string
  refreshToken?: string
  /** Seconds until expiry, relative to when the token was issued. */
  expiresIn?: number
  [k: string]: unknown
}

export interface AuthProfile {
  title?: string
  /**
   * The security scheme(s) of the spec this profile satisfies (several = they apply together). With it, an operation uses
   * the first listed profile that satisfies one of its requirements.
   */
  scheme?: string | string[]
  login?: () => Promise<RequestDef<any, any, any>>
  token?: (res: ApiResponse<number, any>) => Session
  apply: { headers?: Record<string, string>; query?: Record<string, string> }
  retryOn401?: boolean
  /**
   * An interactive sign-in the UI can offer (authorization code with PKCE, or implicit), which the runner ignores; or a
   * client credentials grant, which the runner performs itself.
   * `authorizationUrl`, `tokenUrl`, `openIdConnectUrl` and `clientId` may use environment variables
   * (`'{{issuer}}/token'`).
   */
  oauth?: OAuthSettings
}

export type RunEvent =
  | {
      type: 'run:start'
      id: string
      title?: string
      kind?: 'request' | 'sequence'
      tags?: string[]
    }
  | { type: 'step:start'; name: string }
  | { type: 'auth:login'; profile: string }
  | {
      type: 'auth:profile'
      name: string
      service: string
      profile: string
      reason: ProfileReason
    }
  | { type: 'request'; name: string; request: RenderedRequest }
  | { type: 'response'; name: string; status: number; durationMs: number }
  | { type: 'capture'; name: string; captured: Record<string, unknown> }
  | { type: 'assert:pass'; name: string; assertion: AssertionResult }
  | { type: 'assert:fail'; name: string; assertion: AssertionResult }
  | { type: 'input:required'; name: string; controls: ReturnType<typeof describeControls> }
  | { type: 'script:log'; name: string; message: string }
  | { type: 'step:end'; name: string; status: StepResult['status'] }
  | { type: 'done'; result: RunResult }

export interface RunOptions {
  env: string
  /** config.vars, then environments[env].vars, then the environment's file. */
  vars?: Record<string, unknown>
  /** Highest-precedence overrides (UI vars panel, CLI --var). */
  overrides?: Record<string, unknown>
  /** Flow input values: the ones a person would set (UI controls, CLI --input). */
  inputs?: Record<string, unknown>
  transport: Transport
  /**
   * What lets script steps run: the kind of host this is (a page, or node), its `fetch`, and the few things only it can do.
   * Without it, a script that needs one is skipped, with its flow. The mock environment answers a script with its mock
   * and needs no host.
   */
  scripts?: ScriptHost
  /** Resolved secret values, keyed by secret name. Not needed in the mock env. */
  secrets?: Record<string, string>
  /**
   * Refuse to send a request that may change data (anything but GET, HEAD and OPTIONS, a GraphQL mutation, or a request
   * not marked `safe`). Auth logins are exempt. For runs against real environments that must not write.
   */
  readOnly?: boolean
  /**
   * A request with no `assert` of its own passes only on a 2xx response (recorded as the assertion `status is 2xx`);
   * one with an `assert` is judged by that alone. Off, a request with no `assert` passes whatever the status.
   */
  implicitStatusCheck?: boolean
  /** Leave `{{secrets.*}}` placeholders in the wire request (a trusted server substitutes them). */
  deferSecrets?: boolean
  auth?: Record<string, AuthProfile>
  /** service -> default auth profile name. */
  serviceAuth?: Record<string, string | string[]>
  /** Called at `input()` steps; omit for headless (inputs given > default > first option). */
  onInput?: (req: {
    name: string
    controls: ReturnType<typeof describeControls>
  }) => Promise<Record<string, unknown>> | Record<string, unknown>
  onEvent?: (e: RunEvent) => void
  signal?: AbortSignal
  now?: () => number
  locale?: string
  seed?: number
  usedDrafts?: boolean
  /** Continue-on-failure and assert mode defaults. */
  assertMode?: AssertMode
  /** Resolves `RequestInput.example` names; supplied by the CLI and UI from their registries. */
  example?: ExampleLoader
  /** Reads files named by upload fields (path relative to the example's `dir`). */
  readFile?: FileReader
  /**
   * How long each request waits for an answer, in milliseconds, when the request does not say (`timeoutMs` on the request
   * wins). 0 waits for as long as it takes. Default: 30 seconds.
   */
  timeoutMs?: number
  /** The `mock` environment answers with this status (the UI's "Respond with"). */
  mockStatus?: number
  /** With `mockStatus`: which of that status's variants answers, by name (the first when there is no such name). */
  mockVariant?: string
}

// ---------------- internals ----------------

const now0 = () => Date.now()

interface Runtime {
  o: RunOptions
  sessions: Map<string, { session: Session; expiresAt?: number }>
  inflight: Map<string, Promise<void>>
  mask: Set<string>
  seqAuth?: string | false
  seqAssertMode?: AssertMode
}

class StepError extends Error {}

function rid() {
  return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

const lower = (h: Record<string, string> = {}) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))

function evalInit(init: Record<string, unknown> | undefined) {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(init ?? {}))
    out[k] = typeof v === 'function' ? (v as () => unknown)() : v
  return out
}

async function resolveSource<T>(
  src: T | (() => Promise<{ default: T }>) | undefined,
): Promise<T | undefined> {
  if (typeof src === 'function')
    return (await (src as () => Promise<{ default: T }>)()).default as T
  return src as T | undefined
}

type FileFn = (path: string) => Promise<unknown>

async function mapPath(node: unknown, keys: string[], fn: FileFn): Promise<unknown> {
  if (keys.length === 0) {
    if (Array.isArray(node))
      return Promise.all(node.map((n) => (typeof n === 'string' ? fn(n) : n)))
    return typeof node === 'string' ? fn(node) : node
  }
  if (Array.isArray(node)) return Promise.all(node.map((n) => mapPath(n, keys, fn)))
  const [head, ...rest] = keys as [string, ...string[]]
  if (isPlainObject(node) && head in node)
    return { ...node, [head]: await mapPath(node[head], rest, fn) }
  return node
}

/** Replace upload-field paths in a rendered body with the files they name. */
async function attachFiles(
  body: unknown,
  paths: string[],
  encoding: string,
  read: FileReader,
  dir?: string,
): Promise<unknown> {
  const fn: FileFn = (p) => read(p, dir)
  if (encoding === 'binary') return typeof body === 'string' ? fn(body) : body
  let out = body
  for (const p of paths) out = await mapPath(out, p.split('.'), fn)
  return out
}

function usesOf(
  names: Iterable<string>,
  layers: [VarUse['source'], Record<string, unknown>][],
  from: Record<string, string>,
): VarUse[] {
  const seen = new Set<string>()
  const out: VarUse[] = []
  for (const name of names) {
    if (isDeferred(name) || isFakerName(name)) continue
    const key = rootName(name)
    if (seen.has(key)) continue
    seen.add(key)
    for (let i = layers.length - 1; i >= 0; i--) {
      const [source, vars] = layers[i] as [VarUse['source'], Record<string, unknown>]
      if (key in vars) {
        const use: VarUse =
          source === 'capture' ? { key, source, step: from[key] } : { key, source }
        if (source === 'capture') {
          const lower = layers
            .slice(0, i)
            .reverse()
            .find(([, v]) => key in v)
          const [was, now] = [typeof lower?.[1][key], typeof vars[key]]
          if (lower && was !== now) use.shadows = { source: lower[0], type: was, replacedBy: now }
        }
        out.push(use)
        break
      }
    }
  }
  return out
}

function substitute<T>(value: T, rt: Runtime, profile?: string): T {
  const sub = (s: string): string =>
    s.replace(/\{\{\s*((?:secrets|session)\.[\w$-]+)\s*\}\}/g, (m, name: string) => {
      const [ns, key] = name.split('.') as [string, string]
      if (ns === 'secrets') {
        const v = rt.o.secrets?.[key]
        // The mock env never needs real secrets: placeholders are sent as-is.
        if (v === undefined && (rt.o.env === 'mock' || rt.o.deferSecrets)) return m
        if (v === undefined) throw new MissingSecretsError([key])
        rt.mask.add(v)
        return v
      }
      const s = profile ? rt.sessions.get(`${rt.o.env}:${profile}`)?.session : undefined
      const v = s?.[key]
      if (v === undefined) throw new StepError(`No session value "${key}" for profile "${profile}"`)
      rt.mask.add(String(v))
      return String(v)
    })
  const walk = (v: unknown): unknown => {
    if (isBlob(v)) return v
    if (typeof v === 'string') return sub(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as T
}

/** Events are masked as they are emitted: a listener (a stream, a log) must never see a secret value. */
function emit(rt: Runtime, e: RunEvent) {
  rt.o.onEvent?.(rt.mask.size ? maskDeep(e, rt.mask) : e)
}

export const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** True when the request cannot change data: a read method, a GraphQL query, or one marked `safe`. */
function isReadOnly(def: RequestDef<any, any, any>, prepared: PreparedRequest): boolean {
  if (def.input.safe) return true
  if (READ_METHODS.has(prepared.method)) return true
  if (prepared.encoding === 'graphql') {
    const body = prepared.body as { query?: unknown } | undefined
    return typeof body?.query === 'string' && !/(^|[\s}])mutation\b/.test(body.query)
  }
  return false
}

/** True when the spec says credentials are required (any non-empty list of requirements, or the old flag). */
const isSecured = (security: OpMeta['security']): boolean | undefined =>
  Array.isArray(security) ? security.length > 0 : security
const listOf = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v]

function profileFor(
  rt: Runtime,
  def: RequestDef<any, any, any>,
): { name?: string; reason?: ProfileReason } {
  return resolveProfile({
    explicit: def.input.auth !== undefined ? def.input.auth : rt.seqAuth,
    listed: listOf(rt.o.serviceAuth?.[def.op.service]),
    auth: rt.o.auth,
    security: def.op.security,
  })
}

function toApiResponse(raw: RawResponse, durationMs: number): ApiResponse<number, any> {
  return {
    status: raw.status,
    ok: raw.status >= 200 && raw.status < 300,
    headers: lower(raw.headers),
    data: raw.body,
    text: raw.text,
    durationMs,
  }
}

/** Base64 of text that may not be Latin-1. */
const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

/** The profile's client credentials grant, when it has one and no login request of its own. */
function clientCredentialsOf(prof: AuthProfile): OAuthClientCredentials | undefined {
  return !prof.login && prof.oauth && isClientCredentials(prof.oauth) ? prof.oauth : undefined
}

/**
 * The client credentials grant: one form POST to the token endpoint, no person. The id and secret are `{{secrets.*}}`
 * placeholders; they are filled here when the run holds the values (the CLI, a bundle) and left for a trusted server to fill
 * when it does not (the dev proxy). The call is made as the reserved service `auth:<profile>`, which a transport resolves to
 * the token endpoint's origin.
 */
async function fetchClientToken(
  rt: Runtime,
  profile: string,
  oauth: OAuthClientCredentials,
  authResults: StepResult[],
): Promise<{ session: Session; expiresAt?: number }> {
  if (rt.o.env === 'mock') return { session: { accessToken: 'mock-token' } }
  const name = `Token (${profile})`
  let token: URL
  let rendered: OAuthClientCredentials
  try {
    rendered = oauthFor(oauth, { ...rt.o.vars, ...rt.o.overrides }, profile)
    token = new URL(rendered.tokenUrl)
  } catch (e) {
    throw new StepError(
      `Profile "${profile}" has no usable token address: ${e instanceof Error ? e.message : e}`,
    )
  }
  const { clientId, clientSecret } = substitute(
    { clientId: rendered.clientId, clientSecret: rendered.clientSecret },
    rt,
  )
  // the values are in hand only when nothing was deferred; a placeholder cannot be base64-encoded
  const basic = rendered.clientAuth === 'basic' && !/\{\{/.test(clientId + clientSecret)
  const authorization = basic ? `Basic ${base64(`${clientId}:${clientSecret}`)}` : undefined
  if (authorization) rt.mask.add(authorization)
  const prepared: PreparedRequest = {
    service: authServiceName(profile),
    opId: 'oauth-token',
    method: 'POST',
    url: token.pathname,
    query: Object.fromEntries(token.searchParams),
    headers: { accept: 'application/json', ...(authorization ? { authorization } : {}) },
    body: clientCredentialsFields({
      clientId,
      clientSecret,
      scopes: Object.keys(rendered.scopes ?? {}),
      basic,
    }),
    encoding: 'form',
    timeoutMs: rt.o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  const request: RenderedRequest = {
    opId: prepared.opId,
    method: prepared.method,
    service: prepared.service,
    url: prepared.url,
    query: prepared.query,
    headers: prepared.headers,
    body: prepared.body,
    profile,
  }
  const result: StepResult = {
    name,
    kind: 'auth',
    status: 'pass',
    request,
    assertions: [],
    captured: {},
    durationMs: 0,
  }
  authResults.push(result)
  emit(rt, { type: 'step:start', name })
  emit(rt, { type: 'request', name, request })
  const t0 = rt.o.now?.() ?? now0()
  const fail = (message: string): never => {
    result.status = 'error'
    result.error = message
    result.durationMs = (rt.o.now?.() ?? now0()) - t0
    emit(rt, { type: 'step:end', name, status: 'error' })
    throw new StepError(message)
  }
  let raw: RawResponse
  try {
    raw = await rt.o.transport(prepared, rt.o.signal)
  } catch (e) {
    return fail(
      `Token request for profile "${profile}" failed: ${e instanceof Error ? e.message : e}`,
    )
  }
  const durationMs = (rt.o.now?.() ?? now0()) - t0
  result.durationMs = durationMs
  result.response = { status: raw.status, headers: lower(raw.headers), body: raw.body, durationMs }
  emit(rt, { type: 'response', name, status: raw.status, durationMs })
  let parsed: ReturnType<typeof parseTokenResponse>
  try {
    if (raw.status < 200 || raw.status >= 300) {
      const body = raw.body as { error?: unknown; error_description?: unknown } | undefined
      const why = typeof body?.error === 'string' ? `: ${body.error}` : ''
      throw new Error(`the token endpoint answered ${raw.status}${why}`)
    }
    parsed = parseTokenResponse(raw.body)
  } catch (e) {
    return fail(
      `Token request for profile "${profile}" failed (${e instanceof Error ? e.message : e})`,
    )
  }
  rt.mask.add(parsed.accessToken)
  emit(rt, { type: 'step:end', name, status: 'pass' })
  const session: Session = {
    accessToken: parsed.accessToken,
    ...(parsed.expiresIn !== undefined ? { expiresIn: parsed.expiresIn } : {}),
  }
  return {
    session,
    expiresAt:
      parsed.expiresIn !== undefined
        ? (rt.o.now?.() ?? now0()) + parsed.expiresIn * 1000
        : undefined,
  }
}

async function ensureSession(
  rt: Runtime,
  profile: string,
  authResults: StepResult[],
  force = false,
): Promise<void> {
  const prof0 = rt.o.auth?.[profile] as AuthProfile
  const grant = clientCredentialsOf(prof0)
  // Static-token profiles (API keys, PATs) apply secrets directly and need no session.
  if (!grant && (!prof0.login || !prof0.token)) return
  const key = `${rt.o.env}:${profile}`
  const cur = rt.sessions.get(key)
  const valid = cur && (cur.expiresAt === undefined || cur.expiresAt > (rt.o.now?.() ?? now0()))
  if (valid && !force) return
  const pending = rt.inflight.get(key)
  if (pending) return pending
  const p = (async () => {
    if (grant) {
      emit(rt, { type: 'auth:login', profile })
      rt.sessions.set(key, await fetchClientToken(rt, profile, grant, authResults))
      return
    }
    const prof = prof0 as Required<Pick<AuthProfile, 'login' | 'token'>> & AuthProfile
    emit(rt, { type: 'auth:login', profile })
    const loginDef = await prof.login()
    const { result, response } = await execute(
      rt,
      loginDef,
      `Login (${profile})`,
      NO_FLOW,
      'auth',
      true,
    )
    authResults.push(result)
    if (!response?.ok)
      throw new StepError(`Login for profile "${profile}" failed (${response?.status})`)
    const session = prof.token(response)
    const expiresAt =
      typeof session.expiresIn === 'number'
        ? (rt.o.now?.() ?? now0()) + session.expiresIn * 1000
        : undefined
    rt.sessions.set(key, { session, expiresAt })
    for (const v of Object.values(session)) if (typeof v === 'string') rt.mask.add(v)
  })().finally(() => rt.inflight.delete(key))
  rt.inflight.set(key, p)
  return p
}

/** What earlier steps and the sequence hand to a request. */
interface Flow {
  inputs: Record<string, unknown>
  captured: Record<string, unknown>
  /** capture name -> the step that produced it */
  from: Record<string, string>
}

const NO_FLOW: Flow = { inputs: {}, captured: {}, from: {} }

interface ExecOut {
  result: StepResult
  response?: ApiResponse<number, any>
  authResults: StepResult[]
}

async function execute(
  rt: Runtime,
  def: RequestDef<any, any, any>,
  name: string,
  flow: Flow,
  kind: StepResult['kind'] = 'request',
  noAuth = false,
): Promise<ExecOut & { response?: ApiResponse<number, any> }> {
  const t0 = rt.o.now?.() ?? now0()
  const authResults: StepResult[] = []
  const result: StepResult = {
    name,
    kind,
    status: 'pass',
    assertions: [],
    captured: {},
    durationMs: 0,
  }
  const mode = def.input.assertMode ?? rt.seqAssertMode ?? rt.o.assertMode ?? 'soft'
  emit(rt, { type: 'step:start', name })
  let response: ApiResponse<number, any> | undefined
  try {
    const layers: [VarUse['source'], Record<string, unknown>][] = [
      ['config', rt.o.vars ?? {}],
      ['init', evalInit(def.input.init)],
      ['input', flow.inputs],
      ['capture', flow.captured],
      ['override', evalInit(def.varOverrides)],
      ['override', rt.o.overrides ?? {}],
    ]
    const scope: Record<string, unknown> = Object.assign({}, ...layers.map((l) => l[1]))

    let example: Example | undefined
    if (def.input.example) {
      example = await rt.o.example?.(def.op, def.input.example)
      if (!example) throw new StepError(`Example "${def.input.example}" not found for ${def.op.id}`)
    }

    let data = deepMerge<unknown>(
      example?.body,
      await resolveSource<unknown>(def.input.data as any),
    )
    for (const patch of def.dataPatches) data = deepMerge(data, patch)
    const pathT = deepMerge<unknown>(example?.path ?? {}, def.input.path ?? {})
    const queryT = deepMerge<unknown>(example?.query ?? {}, def.input.query ?? {})
    const headersT = { ...(example?.headers ?? {}), ...(def.input.headers ?? {}) }
    result.uses = usesOf(collectPlaceholders([data, pathT, queryT, headersT]), layers, flow.from)

    let body = data === undefined ? undefined : render(data, scope)
    const pathParams = (render(pathT, scope) ?? {}) as Record<string, unknown>
    const query = (render(queryT, scope) ?? {}) as Record<string, unknown>
    let headers = lower(render(headersT, scope))
    const encoding = def.input.encoding ?? def.op.encoding ?? (body === undefined ? 'none' : 'json')
    if (body !== undefined && rt.o.readFile && (def.op.files?.length || encoding === 'binary'))
      body = await attachFiles(body, def.op.files ?? [], encoding, rt.o.readFile, example?.dir)

    const chosen = noAuth ? {} : profileFor(rt, def)
    const profile = chosen.name
    const prof = profile ? rt.o.auth?.[profile] : undefined
    const authQuery: Record<string, unknown> = {}
    if (prof && profile) {
      headers = { ...lower(render(prof.apply.headers ?? {}, scope)), ...headers }
      Object.assign(authQuery, render(prof.apply.query ?? {}, scope))
    }

    const url = def.op.path.replace(/\{([^}]+)\}/g, (_, k: string) => {
      const v = pathParams[k]
      if (v === undefined || v === null) throw new StepError(`Missing path parameter "${k}"`)
      return encodeURIComponent(String(v))
    })
    const q: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries({ ...query, ...authQuery })) {
      if (v === undefined || v === null) continue
      q[k] = Array.isArray(v) ? v.map(String) : String(v)
    }
    const prepared: PreparedRequest = {
      service: def.op.service,
      opId: def.op.id,
      method: def.op.method,
      url,
      query: q,
      headers,
      body,
      encoding,
      mediaType: encoding === 'binary' ? def.op.mediaType : undefined,
      formArrays: def.op.formArrays,
      timeoutMs: def.input.timeoutMs ?? rt.o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      mockStatus: rt.o.env === 'mock' ? rt.o.mockStatus : undefined,
      mockVariant: rt.o.env === 'mock' ? rt.o.mockVariant : undefined,
      mock:
        rt.o.env === 'mock'
          ? {
              hook: def.mockHook,
              vars: scope,
              pathParams,
              rawQuery: query,
              // a profile sent credentials, in whatever header or query value the spec names them
              secured: profile ? false : isSecured(def.op.security),
            }
          : undefined,
    }
    result.request = {
      opId: def.op.id,
      method: prepared.method,
      service: prepared.service,
      url: prepared.url,
      query: prepared.query,
      headers: prepared.headers,
      body: describeFiles(prepared.body),
      profile,
      ...(profile && chosen.reason ? { profileReason: chosen.reason } : {}),
    }
    if (profile && chosen.reason)
      emit(rt, {
        type: 'auth:profile',
        name,
        service: def.op.service,
        profile,
        reason: chosen.reason,
      })
    emit(rt, { type: 'request', name, request: result.request })
    if (rt.o.readOnly && kind !== 'auth' && !isReadOnly(def, prepared))
      throw new StepError(
        `Refusing ${prepared.method} ${def.op.path} in "${rt.o.env}": this is a --safe run, which only reads.`,
      )

    const send = async () => {
      if (profile) await ensureSession(rt, profile, authResults)
      const { mock: mockHints, ...plain } = prepared
      const wire: PreparedRequest = { ...substitute(plain, rt, profile), mock: mockHints }
      const s0 = rt.o.now?.() ?? now0()
      const raw = await rt.o.transport(wire, rt.o.signal)
      return toApiResponse(raw, (rt.o.now?.() ?? now0()) - s0)
    }
    response = await send()
    if (
      response.status === 401 &&
      profile &&
      prof?.retryOn401 !== false &&
      (prof?.login || (prof && clientCredentialsOf(prof)))
    ) {
      await ensureSession(rt, profile, authResults, true)
      response = await send()
    }

    result.response = {
      status: response.status,
      headers: response.headers,
      body: response.data,
      durationMs: response.durationMs,
    }
    emit(rt, { type: 'response', name, status: response.status, durationMs: response.durationMs })

    for (const [k, fn] of Object.entries(def.input.capture ?? {})) {
      result.captured[k] = (fn as (r: unknown, v: unknown) => unknown)(response, scope)
    }
    emit(rt, { type: 'capture', name, captured: result.captured })

    if (def.input.assert) {
      const a = createAsserter(mode)
      try {
        await def.input.assert(response as any, {
          assert: a.assert,
          vars: { ...scope, ...result.captured } as any,
          req: result.request as RenderedRequest,
        })
      } catch (e: any) {
        if (e?.name !== 'Assertion') {
          result.status = 'error'
          result.error = `assert threw: ${e?.message ?? e}`
        }
      }
      result.assertions = a.results
      for (const r of a.results) {
        emit(rt, { type: r.pass ? 'assert:pass' : 'assert:fail', name, assertion: r })
      }
    } else if (rt.o.implicitStatusCheck && kind === 'request') {
      const pass = response.status >= 200 && response.status < 300
      const implicit: AssertionResult = {
        label: 'status is 2xx',
        operator: 'status',
        pass,
        actual: response.status,
        expected: '2xx',
      }
      result.assertions = [implicit]
      emit(rt, { type: pass ? 'assert:pass' : 'assert:fail', name, assertion: implicit })
    }
    if (result.status === 'pass' && result.assertions.some((r) => !r.pass)) result.status = 'fail'
  } catch (e: any) {
    result.status = 'error'
    result.error = e instanceof Error ? e.message : String(e)
    const hint = hintOf(e)
    if (hint) result.errorHint = hint
  }
  result.durationMs = (rt.o.now?.() ?? now0()) - t0
  emit(rt, { type: 'step:end', name, status: result.status })
  return { result, response, authResults }
}

/** What a page can offer the person for a failure, when the error that ended a step said so (it carries a `hint`). */
function hintOf(e: unknown): StepResult['errorHint'] {
  const hint = (e as { hint?: { code?: unknown; origin?: unknown } } | undefined)?.hint
  return hint && typeof hint.code === 'string'
    ? { code: hint.code, ...(typeof hint.origin === 'string' ? { origin: hint.origin } : {}) }
    : undefined
}

const STOPPED = 'Stopped before the step finished.'

/** Names only a browser has. A script run in node that reaches for one needs a browser, whatever it says it is. */
const BROWSER_GLOBALS = [
  'Element',
  'HTMLElement',
  'Image',
  'MutationObserver',
  'XMLHttpRequest',
  'alert',
  'document',
  'history',
  'localStorage',
  'location',
  'navigator',
  'screen',
  'sessionStorage',
]
const MISSING_GLOBAL = new RegExp(`\\b(${BROWSER_GLOBALS.join('|')}) is not defined\\b`)

/** What a thrown value says: an error from another realm (the node host's sandbox) is no `Error` here, but has a message. */
const messageOf = (e: unknown): string => {
  const m = (e as { message?: unknown } | undefined)?.message
  return typeof m === 'string' ? m : String(e)
}

/**
 * A script run in node that fails for want of `document`, `navigator` and the like needs a browser: say so, in place of a
 * bare "document is not defined" that leaves the author to work out why. Only a node host is told this; in a page those
 * names exist.
 */
function explainMissingGlobal(message: string, host: ScriptHost | undefined): string {
  const name = host?.runtime === 'node' ? MISSING_GLOBAL.exec(message)?.[1] : undefined
  return name
    ? `${message}. This script uses \`${name}\`, which a run in node does not have. If it needs a browser, give it runtime: 'browser'.`
    : message
}

/** Waits, and ends early with an error when the run is stopped. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((done, stop) => {
    if (signal?.aborted) return stop(new StepError(STOPPED))
    const onAbort = () => {
      clearTimeout(timer)
      stop(new StepError(STOPPED))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      done()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** A control with no default that nothing gave a value: a person has to say what it is (`''` and 0 are no answer). */
const NEEDS_VALUE = new Set(['text', 'number', 'date'])

/**
 * Runs one script step: its inputs from `.with()` and the flow (as a request's fields are), then the body, or in the `mock`
 * environment the contract's output example (which the `withMock` hook may change). What the body returns is what the
 * step captures. A script that needs a host this is not is skipped, with a note, and the flow goes on or is ended by the
 * caller.
 */
async function runScript(
  rt: Runtime,
  def: ScriptDef<any, any, any>,
  name: string,
  flow: Flow,
): Promise<StepResult> {
  const t0 = rt.o.now?.() ?? now0()
  const result: StepResult = {
    name,
    kind: 'script',
    status: 'pass',
    assertions: [],
    captured: {},
    durationMs: 0,
    script: { id: def.meta.id, runtime: def.meta.runtime, inputs: {} },
  }
  const mode = def.assertMode ?? rt.seqAssertMode ?? rt.o.assertMode ?? 'soft'
  const a = createAsserter(mode)
  const logs: string[] = []
  const stopper = new AbortController()
  let timedOut = false
  emit(rt, { type: 'step:start', name })
  const relay = () => stopper.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const host = rt.o.scripts
    const mocked = rt.o.env === 'mock'
    // A step this host cannot run is skipped before anything else: what it would have been given may not exist here
    const why = mocked ? undefined : scriptSkipReason(def, host?.runtime)
    if (why) {
      result.status = 'skipped'
      result.note = why
      result.durationMs = (rt.o.now?.() ?? now0()) - t0
      emit(rt, { type: 'step:end', name, status: 'skipped' })
      return result
    }
    const layers: [VarUse['source'], Record<string, unknown>][] = [
      ['config', rt.o.vars ?? {}],
      ['input', flow.inputs],
      ['capture', flow.captured],
      ['override', rt.o.overrides ?? {}],
    ]
    const scope: Record<string, unknown> = Object.assign({}, ...layers.map((l) => l[1]))
    const placeholders = collectPlaceholders(def.given)
    result.uses = usesOf(placeholders, layers, flow.from)
    if ([...placeholders].some(isDeferred))
      throw new StepError(
        `Script ${def.meta.id} is given a {{secrets.*}} or {{session.*}} placeholder: a script cannot be handed secrets. Capture what it needs from an earlier request instead.`,
      )
    const given = render(def.given, scope) as Record<string, unknown>
    for (const [k, ctl] of Object.entries(def.inputs as Controls))
      if (given[k] === undefined && NEEDS_VALUE.has(ctl.kind) && ctl.opts.default === undefined)
        throw new StepError(
          `Missing input "${k}" of script ${def.meta.id}: give it with .with({ inputs: { ${k}: ... } }), or give the control a default.`,
        )
    const inputs = resolveControls(def.inputs as Controls, given)
    result.script = { id: def.meta.id, runtime: def.meta.runtime, inputs }

    let out: unknown
    if (mocked) {
      // the script's mock answers, in any host: nothing is fetched and no body is loaded
      if (!def.mockHook)
        throw new StepError(
          `Script ${def.meta.id} has no mock: the mock environment never runs a body. Wrap it: withMock(script({ ... }), ({ inputs }) => ({ ... })) returns what it answers.`,
        )
      const res = { delayMs: 0 }
      out = await def.mockHook({ inputs, vars: scope }, res)
      if (res.delayMs) await wait(res.delayMs, rt.o.signal)
    } else {
      const there = host as ScriptHost
      if (rt.o.signal?.aborted) stopper.abort()
      else rt.o.signal?.addEventListener('abort', relay, { once: true })
      // no person waits on a node run: it gets the run's time limit, as a request does
      const limit =
        def.meta.timeoutMs ??
        (there.runtime === 'node' ? (rt.o.timeoutMs ?? DEFAULT_TIMEOUT_MS) : undefined)
      if (limit)
        timer = setTimeout(() => {
          timedOut = true
          stopper.abort()
        }, limit)
      const guarded: typeof fetch = async (input, init) => {
        const method = (
          init?.method ??
          (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
        ).toUpperCase()
        if (rt.o.readOnly && !def.meta.safe && !READ_METHODS.has(method)) {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          throw new StepError(
            `Refusing ${method} ${url} in "${rt.o.env}": this is a --safe run, which only reads. Mark the script safe: true if it only reads.`,
          )
        }
        // Stop ends a call even when the body gave it a signal of its own
        const signal =
          init?.signal && typeof AbortSignal.any === 'function'
            ? AbortSignal.any([init.signal, stopper.signal])
            : (init?.signal ?? stopper.signal)
        return there.fetch(input, { ...init, signal })
      }
      const h: ScriptHelpers = {
        fetch: guarded,
        loadScript: async (url, o) => {
          if (!there.loadScript) throw new StepError('This host cannot load a script file.')
          return (await there.loadScript(url, o)) as any
        },
        mount: async () => {
          if (!there.mount)
            throw new StepError('This script needs a place on the page, and this host has none.')
          return there.mount(name, stopper.signal)
        },
        signal: stopper.signal,
        env: rt.o.env,
        vars: scope,
        log: (message) => {
          logs.push(message)
          emit(rt, { type: 'script:log', name, message })
        },
        runtime: there.runtime,
      }
      const endedError = () => new StepError(timedOut ? `Timed out after ${limit}ms.` : STOPPED)
      const ended = new Promise<never>((_, stop) => {
        const fire = () => stop(endedError())
        if (stopper.signal.aborted) fire()
        else stopper.signal.addEventListener('abort', fire, { once: true })
      })
      // Stop may come while the body is still being loaded: nothing is waiting on `ended` yet, so it is handled here
      ended.catch(() => {})
      const body = def.run ?? (await def.load?.())?.run
      if (typeof body !== 'function')
        throw new StepError(`Script ${def.meta.id} has no body: its loader gave no \`run\` export.`)
      // stopped while the body was loading: it is not started. `ended` goes first in the race, so a body that finishes in
      // the same moment as a Stop does not win it
      if (stopper.signal.aborted) throw endedError()
      out = await Promise.race([ended, body(inputs, h)])
    }

    if (!isPlainObject(out))
      throw new StepError(
        `Script ${def.meta.id} must return an object, and so must its mock: its fields are what the step captures.`,
      )
    result.script.output = out
    if (def.capture)
      for (const [k, fn] of Object.entries(def.capture)) result.captured[k] = fn(out, scope)
    else result.captured = { ...out }
    emit(rt, { type: 'capture', name, captured: result.captured })
    if (def.assert)
      await def.assert(out, { assert: a.assert, vars: { ...scope, ...result.captured }, inputs })
  } catch (e: any) {
    // a failed check ends the body in a hard run; it is recorded below, and is no error of its own
    if (e?.name !== 'Assertion') {
      result.status = 'error'
      result.error = explainMissingGlobal(messageOf(e), rt.o.scripts)
      const hint = hintOf(e)
      if (hint) result.errorHint = hint
    }
  } finally {
    clearTimeout(timer)
    rt.o.signal?.removeEventListener('abort', relay)
  }
  if (logs.length) result.script = { ...(result.script as NonNullable<StepResult['script']>), logs }
  result.assertions = a.results
  for (const r of a.results)
    emit(rt, { type: r.pass ? 'assert:pass' : 'assert:fail', name, assertion: r })
  if (result.status === 'pass' && a.results.some((r) => !r.pass)) result.status = 'fail'
  result.durationMs = (rt.o.now?.() ?? now0()) - t0
  emit(rt, { type: 'step:end', name, status: result.status })
  return result
}

function summarize(steps: StepResult[]): RunResult['totals'] {
  const t = { steps: 0, passed: 0, failed: 0, skipped: 0, assertions: { passed: 0, failed: 0 } }
  const visit = (s: StepResult) => {
    if (s.children?.length) {
      s.children.forEach(visit)
      return
    }
    t.steps++
    if (s.status === 'pass') t.passed++
    else if (s.status === 'skipped') t.skipped++
    else t.failed++
    for (const a of s.assertions) a.pass ? t.assertions.passed++ : t.assertions.failed++
  }
  steps.forEach(visit)
  return t
}

function overall(steps: StepResult[]): RunResult['status'] {
  const all: StepResult[] = []
  const walk = (s: StepResult) => {
    all.push(s)
    s.children?.forEach(walk)
  }
  steps.forEach(walk)
  if (all.some((s) => s.status === 'error')) return 'error'
  if (all.some((s) => s.status === 'fail')) return 'fail'
  return 'pass'
}

function finish(
  rt: Runtime,
  kind: RunResult['kind'],
  meta: { id: string; title: string; tags?: string[] },
  steps: StepResult[],
  startedAt: number,
  skipped?: string,
): RunResult {
  const result: RunResult = {
    schemaVersion: 1,
    runId: rid(),
    kind,
    id: meta.id,
    title: meta.title,
    env: rt.o.env,
    locale: rt.o.locale,
    seed: rt.o.seed,
    usedDrafts: rt.o.usedDrafts ?? false,
    tags: meta.tags ?? [],
    status: overall(steps),
    ...(skipped && steps.every((s) => s.status === 'skipped') ? { skipped } : {}),
    startedAt: new Date(startedAt).toISOString(),
    durationMs: (rt.o.now?.() ?? now0()) - startedAt,
    totals: summarize(steps),
    steps,
  }
  const masked = maskDeep(result, rt.mask)
  emit(rt, { type: 'done', result: masked })
  return masked
}

/**
 * Static secret scan; request steps given as functions are checked when they run. With `serviceAuth`
 * only the auth profiles the target can use are scanned, so a keyless service needs no secrets; steps
 * the scan can't see (functions) bring every profile back.
 */
export async function collectSecretNames(
  target: RequestDef<any, any, any> | Sequence<any, any>,
  auth: Record<string, AuthProfile> = {},
  loadExample?: ExampleLoader,
  serviceAuth?: Record<string, string | string[]>,
): Promise<Set<string>> {
  const names = new Set<string>()
  const profiles = new Set<string>()
  let allProfiles = !serviceAuth
  const addDef = async (d: RequestDef<any, any, any>, seqAuth?: string | false) => {
    const { name: profile } = resolveProfile({
      explicit: d.input.auth !== undefined ? d.input.auth : seqAuth,
      listed: listOf(serviceAuth?.[d.op.service]),
      auth,
      security: d.op.security,
    })
    if (profile) profiles.add(profile)
    const data = await resolveSource<unknown>(d.input.data as any).catch(() => undefined)
    const ex = d.input.example
      ? await loadExample?.(d.op, d.input.example).catch(() => undefined)
      : undefined
    for (const v of [
      d.input.headers,
      d.input.path,
      d.input.query,
      data,
      ...d.dataPatches,
      ex?.headers,
      ex?.path,
      ex?.query,
      ex?.body,
    ]) {
      for (const n of collectPlaceholders(v))
        if (isDeferred(n) && n.startsWith('secrets.')) names.add(n.slice(8))
    }
  }
  if (target.kind === 'request') await addDef(target)
  else {
    for (const n of target.nodes) {
      if (n.kind !== 'step') continue
      if (typeof n.def === 'function') allProfiles = true
      else if (n.def.kind === 'request') await addDef(n.def, target.meta.auth)
    }
  }
  for (const [name, p] of Object.entries(auth)) {
    if (!allProfiles && !profiles.has(name)) continue
    for (const v of [p.apply.headers, p.apply.query]) {
      for (const n of collectPlaceholders(v)) if (n.startsWith('secrets.')) names.add(n.slice(8))
    }
    if (p.login) await addDef(await p.login())
    const grant = clientCredentialsOf(p)
    if (grant)
      for (const v of [grant.clientId, grant.clientSecret])
        for (const n of collectPlaceholders(v)) if (n.startsWith('secrets.')) names.add(n.slice(8))
  }
  return names
}

function newRuntime(o: RunOptions): Runtime {
  // every resolved secret is masked from the start, not only once it has been substituted into a request
  return {
    o,
    sessions: new Map(),
    inflight: new Map(),
    mask: new Set(Object.values(o.secrets ?? {})),
  }
}

export async function runRequest(
  def: RequestDef<any, any, any>,
  o: RunOptions,
): Promise<RunResult> {
  const rt = newRuntime(o)
  const t0 = o.now?.() ?? now0()
  emit(rt, {
    type: 'run:start',
    id: def.op.id,
    title: def.input.name ?? def.op.id,
    kind: 'request',
    tags: def.input.tags,
  })
  const name = def.input.name ?? def.op.id
  const { result, authResults } = await execute(rt, def, name, NO_FLOW)
  return finish(
    rt,
    'request',
    { id: def.op.id, title: name, tags: def.input.tags },
    [...authResults, result],
    t0,
  )
}

/** What a node is called in a result: a step given as a script is a script, any other step a request. */
function kindOf(node: StepNode): StepResult['kind'] {
  if (node.kind !== 'step') return node.kind
  return typeof node.def !== 'function' && node.def.kind === 'script' ? 'script' : 'request'
}

export async function runSequence(seq: Sequence<any, any>, o: RunOptions): Promise<RunResult> {
  const rt = newRuntime(o)
  rt.seqAuth = seq.meta.auth
  rt.seqAssertMode = seq.meta.assertMode
  const t0 = o.now?.() ?? now0()
  emit(rt, {
    type: 'run:start',
    id: seq.meta.id,
    title: seq.meta.title,
    kind: 'sequence',
    tags: seq.meta.tags,
  })
  const steps: StepResult[] = []
  // A flow whose scripts need what this host is not does not start (the `mock` environment answers them all): it is
  // skipped as a whole, and counts as passed, so a bundle on a server does not fail for a flow made for the portal.
  const reason = flowSkipReason(seq, o.scripts?.runtime, o.env)
  if (reason) {
    for (const n of seq.nodes)
      steps.push({
        name: n.name,
        kind: kindOf(n),
        status: 'skipped',
        note: reason,
        assertions: [],
        captured: {},
        durationMs: 0,
      })
    return finish(rt, 'sequence', seq.meta, steps, t0, reason)
  }
  const captured: Record<string, any> = {}
  const from: Record<string, string> = {}
  const remember = (values: Record<string, unknown>, step: string) => {
    Object.assign(captured, values)
    for (const k of Object.keys(values)) from[k] = step
  }
  let inputs: Record<string, unknown>
  try {
    inputs = resolveControls(seq.meta.inputs ?? {}, o.inputs)
  } catch (e: any) {
    steps.push({
      name: 'inputs',
      kind: 'input',
      status: 'error',
      assertions: [],
      captured: {},
      error: e.message,
      durationMs: 0,
    })
    return finish(rt, 'sequence', seq.meta, steps, t0)
  }
  const vars = o.vars ?? {}
  const ctx = (): StepCtx<any, any> => ({
    inputs,
    captured,
    vars: { ...vars, ...(o.overrides ?? {}) },
    env: o.env,
  })
  let failed = false
  /** Set when a script step made by a function needed a host this is not: the rest of the flow is not run here. */
  let halted: string | undefined

  const skip = (name: string, kind: StepResult['kind'], note?: string) =>
    steps.push({
      name,
      kind,
      status: 'skipped',
      ...(note ? { note } : {}),
      assertions: [],
      captured: {},
      durationMs: 0,
    })

  for (const node of seq.nodes) {
    if (halted) {
      skip(node.name, kindOf(node), halted)
      continue
    }
    if (failed && !seq.meta.continueOnFailure) {
      skip(node.name, kindOf(node))
      continue
    }
    if (o.signal?.aborted) {
      skip(node.name, kindOf(node))
      failed = true
      continue
    }
    try {
      if (node.kind === 'step') {
        const def = typeof node.def === 'function' ? node.def(ctx()) : node.def
        if (def.kind === 'script') {
          const result = await runScript(rt, def, node.name, { inputs, captured, from })
          steps.push(result)
          remember(result.captured, node.name)
          if (result.status === 'skipped') halted = result.note
          else if (result.status !== 'pass') failed = true
          continue
        }
        const { result, authResults } = await execute(rt, def, node.name, {
          inputs,
          captured,
          from,
        })
        steps.push(...authResults, result)
        remember(result.captured, node.name)
        if (result.status !== 'pass') failed = true
      } else if (node.kind === 'each') {
        const items = node.items(ctx())
        const parent: StepResult = {
          name: node.name,
          kind: 'each',
          status: 'pass',
          assertions: [],
          captured: {},
          durationMs: 0,
          children: [],
        }
        const p0 = o.now?.() ?? now0()
        const collected: Record<string, unknown[]> = {}
        for (let i = 0; i < items.length; i++) {
          const def = node.def(items[i], ctx(), i)
          const { result, authResults } = await execute(rt, def, `${node.name} #${i + 1}`, {
            inputs,
            captured,
            from,
          })
          parent.children?.push(...authResults, result)
          for (const [k, v] of Object.entries(result.captured)) {
            collected[k] ??= []
            collected[k]?.push(v)
          }
          if (result.status !== 'pass') {
            parent.status = result.status
            if (!seq.meta.continueOnFailure) break
          }
        }
        parent.captured = collected
        parent.durationMs = (o.now?.() ?? now0()) - p0
        remember(collected, node.name)
        steps.push(parent)
        if (parent.status !== 'pass') failed = true
      } else if (node.kind === 'input') {
        const controls: Controls = node.controls(ctx())
        const described = describeControls(controls)
        emit(rt, { type: 'input:required', name: node.name, controls: described })
        const given = o.onInput
          ? await o.onInput({ name: node.name, controls: described })
          : (o.inputs ?? {})
        const values = resolveControls(controls, given)
        inputs = { ...inputs, ...values }
        steps.push({
          name: node.name,
          kind: 'input',
          status: 'pass',
          assertions: [],
          captured: values,
          durationMs: 0,
        })
      } else if (node.kind === 'check') {
        const a = createAsserter(seq.meta.assertMode ?? o.assertMode ?? 'soft')
        const s: StepResult = {
          name: node.name,
          kind: 'check',
          status: 'pass',
          assertions: [],
          captured: {},
          durationMs: 0,
        }
        emit(rt, { type: 'step:start', name: node.name })
        try {
          await node.fn(ctx(), { assert: a.assert })
        } catch (e: any) {
          if (e?.name !== 'Assertion') {
            s.status = 'error'
            s.error = e?.message ?? String(e)
          }
        }
        s.assertions = a.results
        if (s.status === 'pass' && a.results.some((r) => !r.pass)) s.status = 'fail'
        emit(rt, { type: 'step:end', name: node.name, status: s.status })
        steps.push(s)
        if (s.status !== 'pass') failed = true
      }
    } catch (e: any) {
      const isControl = e instanceof ControlError
      steps.push({
        name: node.name,
        kind: kindOf(node),
        status: 'error',
        assertions: [],
        captured: {},
        error: isControl ? e.message : (e?.message ?? String(e)),
        durationMs: 0,
      })
      failed = true
    }
  }
  return finish(rt, 'sequence', seq.meta, steps, t0, halted)
}
