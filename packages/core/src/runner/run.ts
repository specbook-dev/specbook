import { createAsserter } from '../assert'
import { ControlError, type Controls, describeControls, resolveControls } from '../controls'
import type { Example, ExampleLoader, FileReader } from '../example'
import type { OAuthSettings } from '../oauth'
import { MissingSecretsError, maskDeep } from '../secrets'
import type { Sequence, StepCtx } from '../sequence'
import {
  collectPlaceholders,
  deepMerge,
  isDeferred,
  isFakerName,
  isPlainObject,
  render,
} from '../template'
import type {
  ApiResponse,
  AssertionResult,
  AssertMode,
  RenderedRequest,
  RequestDef,
  RunResult,
  StepResult,
  VarUse,
} from '../types'
import { describeFiles, isBlob } from './encode'
import type { PreparedRequest, RawResponse, Transport } from './transport'

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
  login?: () => Promise<RequestDef<any, any, any>>
  token?: (res: ApiResponse<number, any>) => Session
  apply: { headers?: Record<string, string>; query?: Record<string, string> }
  retryOn401?: boolean
  /** an interactive sign-in the UI can offer (authorization code with PKCE); the runner ignores it */
  oauth?: OAuthSettings
}

export type RunEvent =
  | { type: 'run:start'; id: string }
  | { type: 'step:start'; name: string }
  | { type: 'auth:login'; profile: string }
  | { type: 'request'; name: string; request: RenderedRequest }
  | { type: 'response'; name: string; status: number; durationMs: number }
  | { type: 'capture'; name: string; captured: Record<string, unknown> }
  | { type: 'assert:pass'; name: string; assertion: AssertionResult }
  | { type: 'assert:fail'; name: string; assertion: AssertionResult }
  | { type: 'input:required'; name: string; controls: ReturnType<typeof describeControls> }
  | { type: 'step:end'; name: string; status: StepResult['status'] }
  | { type: 'done'; result: RunResult }

export interface RunOptions {
  env: string
  /** config.vars merged with environments[env].vars. */
  vars?: Record<string, unknown>
  /** Highest-precedence overrides (UI vars panel, CLI --var). */
  overrides?: Record<string, unknown>
  /** Sequence param overrides. */
  params?: Record<string, unknown>
  transport: Transport
  /** Resolved secret values, keyed by secret name. Not needed in the mock env. */
  secrets?: Record<string, string>
  /** Leave `{{secrets.*}}` placeholders in the wire request (a trusted server substitutes them). */
  deferSecrets?: boolean
  auth?: Record<string, AuthProfile>
  /** service -> default auth profile name. */
  serviceAuth?: Record<string, string>
  /** Called at `input()` steps; omit for headless (params override > default > first option). */
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
    const key = name.split('.')[0] as string
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

function emit(rt: Runtime, e: RunEvent) {
  rt.o.onEvent?.(e)
}

function profileFor(rt: Runtime, def: RequestDef<any, any, any>): string | undefined {
  if (def.op.security === false) return undefined
  const explicit = def.input.auth !== undefined ? def.input.auth : rt.seqAuth
  if (explicit === false) return undefined
  const name = explicit ?? rt.o.serviceAuth?.[def.op.service]
  return name && rt.o.auth?.[name] ? name : undefined
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

async function ensureSession(
  rt: Runtime,
  profile: string,
  authResults: StepResult[],
  force = false,
): Promise<void> {
  const prof0 = rt.o.auth?.[profile] as AuthProfile
  // Static-token profiles (API keys, PATs) apply secrets directly and need no session.
  if (!prof0.login || !prof0.token) return
  const key = `${rt.o.env}:${profile}`
  const cur = rt.sessions.get(key)
  const valid = cur && (cur.expiresAt === undefined || cur.expiresAt > (rt.o.now?.() ?? now0()))
  if (valid && !force) return
  const pending = rt.inflight.get(key)
  if (pending) return pending
  const p = (async () => {
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
  params: Record<string, unknown>
  captured: Record<string, unknown>
  /** capture name -> the step that produced it */
  from: Record<string, string>
}

const NO_FLOW: Flow = { params: {}, captured: {}, from: {} }

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
      ['param', flow.params],
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

    const profile = noAuth ? undefined : profileFor(rt, def)
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
      timeoutMs: def.input.timeoutMs,
      mockStatus: rt.o.env === 'mock' ? def.input.mock?.status : undefined,
      mock:
        rt.o.env === 'mock'
          ? {
              config: def.input.mock,
              vars: scope,
              pathParams,
              rawQuery: query,
              secured: def.op.security,
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
    }
    emit(rt, { type: 'request', name, request: result.request })

    const send = async () => {
      if (profile) await ensureSession(rt, profile, authResults)
      const { mock: mockHints, ...plain } = prepared
      const wire: PreparedRequest = { ...substitute(plain, rt, profile), mock: mockHints }
      const s0 = rt.o.now?.() ?? now0()
      const raw = await rt.o.transport(wire, rt.o.signal)
      return toApiResponse(raw, (rt.o.now?.() ?? now0()) - s0)
    }
    response = await send()
    if (response.status === 401 && profile && prof?.retryOn401 !== false && prof?.login) {
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
    }
    if (result.status === 'pass' && result.assertions.some((r) => !r.pass)) result.status = 'fail'
  } catch (e: any) {
    result.status = 'error'
    result.error = e instanceof Error ? e.message : String(e)
  }
  result.durationMs = (rt.o.now?.() ?? now0()) - t0
  emit(rt, { type: 'step:end', name, status: result.status })
  return { result, response, authResults }
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
  serviceAuth?: Record<string, string>,
): Promise<Set<string>> {
  const names = new Set<string>()
  const profiles = new Set<string>()
  let allProfiles = !serviceAuth
  const addDef = async (d: RequestDef<any, any, any>, seqAuth?: string | false) => {
    const explicit = d.input.auth !== undefined ? d.input.auth : seqAuth
    const profile = explicit === undefined ? serviceAuth?.[d.op.service] : explicit
    if (d.op.security !== false && profile) profiles.add(profile)
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
      else await addDef(n.def, target.meta.auth)
    }
  }
  for (const [name, p] of Object.entries(auth)) {
    if (!allProfiles && !profiles.has(name)) continue
    for (const v of [p.apply.headers, p.apply.query]) {
      for (const n of collectPlaceholders(v)) if (n.startsWith('secrets.')) names.add(n.slice(8))
    }
    if (p.login) await addDef(await p.login())
  }
  return names
}

function newRuntime(o: RunOptions): Runtime {
  return { o, sessions: new Map(), inflight: new Map(), mask: new Set() }
}

export async function runRequest(
  def: RequestDef<any, any, any>,
  o: RunOptions,
): Promise<RunResult> {
  const rt = newRuntime(o)
  const t0 = o.now?.() ?? now0()
  emit(rt, { type: 'run:start', id: def.op.id })
  const name = def.input.name ?? def.op.id
  const { result, authResults } = await execute(rt, def, name, NO_FLOW)
  return finish(rt, 'request', { id: def.op.id, title: name }, [...authResults, result], t0)
}

export async function runSequence(seq: Sequence<any, any>, o: RunOptions): Promise<RunResult> {
  const rt = newRuntime(o)
  rt.seqAuth = seq.meta.auth
  rt.seqAssertMode = seq.meta.assertMode
  const t0 = o.now?.() ?? now0()
  emit(rt, { type: 'run:start', id: seq.meta.id })
  const steps: StepResult[] = []
  const captured: Record<string, any> = {}
  const from: Record<string, string> = {}
  const remember = (values: Record<string, unknown>, step: string) => {
    Object.assign(captured, values)
    for (const k of Object.keys(values)) from[k] = step
  }
  let params: Record<string, unknown>
  try {
    params = resolveControls(seq.meta.params ?? {}, o.params)
  } catch (e: any) {
    steps.push({
      name: 'params',
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
    params,
    captured,
    vars: { ...vars, ...(o.overrides ?? {}) },
    env: o.env,
  })
  let failed = false

  const skip = (name: string, kind: StepResult['kind']) =>
    steps.push({ name, kind, status: 'skipped', assertions: [], captured: {}, durationMs: 0 })

  for (const node of seq.nodes) {
    if (failed && !seq.meta.continueOnFailure) {
      skip(node.name, node.kind === 'step' ? 'request' : node.kind)
      continue
    }
    if (o.signal?.aborted) {
      skip(node.name, node.kind === 'step' ? 'request' : node.kind)
      failed = true
      continue
    }
    try {
      if (node.kind === 'step') {
        const def = typeof node.def === 'function' ? node.def(ctx()) : node.def
        const { result, authResults } = await execute(rt, def, node.name, {
          params,
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
            params,
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
          : (o.params ?? {})
        const values = resolveControls(controls, given)
        params = { ...params, ...values }
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
        kind: node.kind === 'step' ? 'request' : node.kind,
        status: 'error',
        assertions: [],
        captured: {},
        error: isControl ? e.message : (e?.message ?? String(e)),
        durationMs: 0,
      })
      failed = true
    }
  }
  return finish(rt, 'sequence', seq.meta, steps, t0)
}
