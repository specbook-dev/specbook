// Run orchestration for the UI. Pure TS (no DOM) so it can be unit-tested with a fake registry.
import {
  type AuthProfile,
  createFetchTransport,
  createMockTransport,
  type DiscoveredEndpoints,
  deepMerge,
  type Example,
  installFaker,
  isDiscovery,
  type OpMeta,
  parseDiscovery,
  prepareFaker,
  type RequestDef,
  type RunEvent,
  type RunResult,
  runRequest,
  runSequence,
  type Sequence,
  type SpecbookConfig,
  type Transport,
  usesFaker,
} from '@specbook/core'
import { type ExtensionBridge, extensionTransport } from './extension'
import { absoluteBase, routingTransport, withPageSecrets } from './routing'
import { originOf, type SecretStore, secretStore } from './secrets'

/**
 * The reserved service name a sign-in's token exchange is addressed to. The dev server's proxy answers
 * `auth:<profile>` from the profile's own `oauth.tokenUrl` (the same prefix lives in `@specbook/vite`).
 */
const AUTH_SERVICE_PREFIX = 'auth:'
const authService = (profile: string) => `${AUTH_SERVICE_PREFIX}${encodeURIComponent(profile)}`
/** Likewise for an OpenID Connect discovery document, whose host may differ from the token endpoint's. */
const DISCOVERY_SERVICE_PREFIX = 'discovery:'
const discoveryService = (profile: string) =>
  `${DISCOVERY_SERVICE_PREFIX}${encodeURIComponent(profile)}`

export interface ExampleEntry {
  name: string
  source: 'generated' | 'project'
  /** Folder key; upload paths in the example are relative to it. */
  dir: string
  load: (v: number) => Promise<{ default: unknown }>
}

export interface DocEntry {
  file: string
  operation?: string
  sequence?: string
  title?: string
  load: () => Promise<string>
}

export interface Registry {
  manifests: Record<string, { operations: { id: string; statuses: number[] }[] }>
  /** response examples: `service/Op.<status|default>` */
  examples: Record<string, (v: number) => Promise<{ default: unknown }>>
  /** request examples by `service/Op` */
  requestExamples: Record<string, ExampleEntry[]>
  /** files examples may upload: `<dir>/<name>` -> URL */
  assets: Record<string, () => Promise<string>>
  docs: DocEntry[]
  operations: Record<string, (v: number) => Promise<Record<string, any>>>
  loadConfig: (v: number) => Promise<{ default: any }>
  /** Project's @faker-js/faker (ESM), when installed. */
  loadFaker?: ((v: number) => Promise<Record<string, any>>) | null
  mode?: 'dev' | 'static'
  /** variables from `.specbook/environments/<env>.env`, baked in at build time */
  environmentVars?: Record<string, Record<string, string>>
}

export interface RunInput {
  env: string
  version: number
  /** Forced mock status per run (mock env only). */
  mockStatus?: number
  params?: Record<string, unknown>
  vars?: Record<string, unknown>
  onEvent?: (e: RunEvent) => void
  onInput?: Parameters<typeof runSequence>[1]['onInput']
  signal?: AbortSignal
  proxyBase?: string
  locale?: string
  seed?: number
  /** Folder upload paths are relative to when the request was not built from a named example. */
  fileDir?: string
}

export interface EngineOptions {
  /** The bridge to the browser extension when it is installed and enabled for this page. */
  extension?: () => Promise<ExtensionBridge | undefined>
  /** Where the person's typed secrets are kept (the page's store by default). */
  secrets?: SecretStore
}

export function createEngine(reg: Registry, opts: EngineOptions = {}) {
  const mockLoader = {
    statuses: (service: string, opId: string) =>
      reg.manifests[service]?.operations.find((o) => o.id === opId)?.statuses ?? [],
    async example(service: string, opId: string, status: number) {
      const get = async (s: number | 'default') =>
        (await reg.examples[`${service}/${opId}.${s}`]?.(0))?.default
      return (await get(status)) ?? (await get('default'))
    },
  }

  async function config(version: number): Promise<SpecbookConfig> {
    return (await reg.loadConfig(version)).default as SpecbookConfig
  }

  /** Environments the config marks `production` or `sandbox`; the rest are judged by their name. */
  async function environmentRisks(
    version: number,
  ): Promise<Record<string, 'production' | 'sandbox'>> {
    const c = await config(version)
    const out: Record<string, 'production' | 'sandbox'> = {}
    for (const [name, e] of Object.entries(c.environments ?? {})) {
      const risk = (e as { risk?: string } | undefined)?.risk
      if (risk === 'production' || risk === 'sandbox') out[name] = risk
    }
    return out
  }

  /** One line per environment that has a description, for the pickers' tooltips. */
  async function environmentNotes(version: number): Promise<Record<string, string>> {
    const c = await config(version)
    const out: Record<string, string> = {}
    for (const [name, e] of Object.entries(c.environments ?? {})) {
      const note = (e as { description?: string } | undefined)?.description
      if (note) out[name] = note
    }
    return out
  }

  async function environments(version: number): Promise<string[]> {
    const c = await config(version)
    const envs = new Set<string>(['mock'])
    for (const s of Object.values(c.services ?? {}))
      for (const e of Object.keys(s.baseUrl ?? {})) envs.add(e)
    for (const e of Object.keys(reg.environmentVars ?? {})) envs.add(e)
    for (const e of Object.keys(c.environments ?? {})) envs.add(e)
    return [...envs]
  }

  /** The environment's own variables: read live from the dev server, baked in for static builds. */
  async function environmentVars(env: string): Promise<Record<string, string>> {
    if (reg.mode === 'dev') {
      try {
        const r = await fetch(`/__specbook/environment?env=${encodeURIComponent(env)}`)
        if (r.ok) return ((await r.json()) as { vars: Record<string, string> }).vars
      } catch {
        /* fall back to what was baked in */
      }
    }
    return reg.environmentVars?.[env] ?? {}
  }

  /** Names of the variables the project already supplies in `env`: config, per-environment and env files. */
  async function knownVars(env: string, version: number): Promise<string[]> {
    const c = await config(version)
    return [
      ...new Set([
        ...Object.keys(c.vars ?? {}),
        ...Object.keys(c.environments?.[env]?.vars ?? {}),
        ...Object.keys(await environmentVars(env)),
      ]),
    ]
  }

  /**
   * One transport per run, routing each request by its service (`routeFor`). Typed values are bound to
   * the API's origin first; placeholders left over are filled by the dev server or reported as missing.
   */
  async function transportFor(
    env: string,
    proxyBase: string,
    version: number,
    /** extra services by name -> base URL: a sign-in's token endpoint, which is not a configured service */
    extra: Record<string, string> = {},
  ): Promise<Transport> {
    if (env === 'mock') return createMockTransport({ loader: mockLoader })
    const cfg = await config(version)
    const pageHref = globalThis.location?.href
    const pageOrigin = globalThis.location?.origin
    const baseOf = (service: string) => {
      if (extra[service]) return extra[service]
      const url = cfg.services?.[service]?.baseUrl?.[env]
      if (!url) throw new Error(`No base URL for ${service} in the "${env}" environment`)
      return absoluteBase(url, pageHref)
    }
    const hasProxy = reg.mode !== 'static'
    const bridge = await opts.extension?.()
    const ext = bridge ? extensionTransport(bridge, safeBase) : undefined
    const store = opts.secrets ?? secretStore

    const direct = createFetchTransport({ baseUrl: baseOf })
    const viaProxy = hasProxy
      ? createFetchTransport({ baseUrl: (service) => `${proxyBase}/${env}/${service}` })
      : undefined
    const routed = routingTransport({
      direct: guardCors(withPageSecrets(direct, { store, originFor, unresolved: 'fail' })),
      proxy: viaProxy
        ? withPageSecrets(viaProxy, { store, originFor, unresolved: 'keep' })
        : undefined,
      extension: ext ? withPageSecrets(ext, { store, originFor, unresolved: 'keep' }) : undefined,
      baseOf: safeBase,
      pageOrigin,
    })
    return routed

    function originFor(service: string) {
      return originOf(safeBase(service))
    }
    // routing must not throw for a service with no base URL here: the proxy answers that with a 404
    function safeBase(service: string) {
      try {
        return baseOf(service)
      } catch {
        return ''
      }
    }
    function guardCors(inner: Transport): Transport {
      return async (req, signal) => {
        try {
          return await inner(req, signal)
        } catch (e) {
          // a blocked cross-origin call surfaces as a bare TypeError("Failed to fetch")
          if (
            e instanceof TypeError &&
            (req.service.startsWith(AUTH_SERVICE_PREFIX) ||
              req.service.startsWith(DISCOVERY_SERVICE_PREFIX))
          )
            throw new Error(
              `The browser could not reach the sign-in provider (${extra[req.service] ?? 'unknown'}). It probably does not allow calls from this page (CORS). Embedding the viewer on the API's origin does not help when the sign-in server is on another host; the browser extension can make the call. You can still paste an access token.`,
            )
          if (e instanceof TypeError)
            throw new Error(
              `The browser could not reach ${req.service} in "${env}". The API probably does not allow calls from this page (CORS). It works when the viewer runs on the API's own origin: embed it in the API's docs route ("Embed the viewer" in the README). Mock data keeps working.`,
            )
          throw e
        }
      }
    }
  }

  /** Only the dev server knows its environment files; a hosted proxy would report its own (`managedSecrets`). */
  async function managedSecrets(env: string): Promise<Record<string, string>> {
    if (reg.mode !== 'dev' || env === 'mock') return {}
    try {
      const r = await fetch(`/__specbook/environment?env=${encodeURIComponent(env)}`)
      if (!r.ok) return {}
      const body = (await r.json()) as { secrets?: { name: string; source?: string }[] }
      return Object.fromEntries(
        (body.secrets ?? []).filter((s) => s.source).map((s) => [s.name, s.source as string]),
      )
    } catch {
      return {}
    }
  }

  type SignInEndpoints = DiscoveredEndpoints & { scopes: Record<string, string> }
  const discovered = new Map<string, Promise<DiscoveredEndpoints>>()

  /**
   * Where a profile signs in: the endpoints its config writes out, or the ones its OpenID Connect
   * discovery document names. The document is fetched the way any other call from the page is (through
   * the dev server's proxy when there is one) and remembered for the life of the page.
   */
  async function oauthEndpoints(i: {
    env: string
    version: number
    profile: string
    proxyBase?: string
    signal?: AbortSignal
  }): Promise<SignInEndpoints> {
    if (i.env === 'mock') throw new Error('Sign in needs a live environment, not mock')
    const oauth = ((await config(i.version)).auth?.[i.profile] as AuthProfile | undefined)?.oauth
    if (!oauth) throw new Error(`"${i.profile}" has no sign-in configured`)
    if (!isDiscovery(oauth))
      return {
        authorizationUrl: oauth.authorizationUrl,
        tokenUrl: oauth.tokenUrl,
        scopes: oauth.scopes ?? {},
      }

    const url = new URL(oauth.openIdConnectUrl)
    let found = discovered.get(url.href)
    if (!found) {
      found = (async () => {
        const service = discoveryService(i.profile)
        const send = await transportFor(i.env, i.proxyBase ?? '/__specbook/proxy', i.version, {
          [service]: url.origin,
        })
        const res = await send(
          {
            service,
            opId: 'oidc-discovery',
            method: 'GET',
            url: url.pathname,
            query: Object.fromEntries(url.searchParams),
            headers: { accept: 'application/json' },
            encoding: 'none',
          },
          i.signal,
        )
        if (res.status >= 400)
          throw new Error(`The provider's discovery document answered ${res.status}`)
        return parseDiscovery(res.body)
      })()
      discovered.set(url.href, found)
      // a failure is not remembered: the next click tries again
      found.catch(() => discovered.delete(url.href))
    }
    const endpoints = await found
    return {
      ...endpoints,
      scopes: oauth.scopes && Object.keys(oauth.scopes).length ? oauth.scopes : endpoints.scopes,
    }
  }

  /**
   * A sign-in's code exchange, sent the way any other call from this page is: through the dev server's
   * proxy when there is one, else direct or through the extension. The token endpoint comes from the
   * profile in the config (or its discovery document), never from the caller, so the proxy only ever
   * forwards to the project's own.
   */
  async function oauthExchange(i: {
    env: string
    version: number
    profile: string
    fields: Record<string, string>
    proxyBase?: string
    signal?: AbortSignal
  }): Promise<unknown> {
    const { tokenUrl } = await oauthEndpoints(i)
    const token = new URL(tokenUrl)
    const service = authService(i.profile)
    const send = await transportFor(i.env, i.proxyBase ?? '/__specbook/proxy', i.version, {
      [service]: token.origin,
    })
    const res = await send(
      {
        service,
        opId: 'oauth-token',
        method: 'POST',
        url: token.pathname,
        query: Object.fromEntries(token.searchParams),
        headers: { accept: 'application/json' },
        body: i.fields,
        encoding: 'form',
      },
      i.signal,
    )
    const body = res.body as { error?: unknown } | undefined
    if (res.status >= 400 && typeof body?.error !== 'string')
      throw new Error(`The token endpoint answered ${res.status}`)
    return res.body
  }

  const norm = (p: string) => p.replace(/^\.\//, '')

  /** Display order: the author's examples first, generated ones last. */
  const examplesOf = (key: string): ExampleEntry[] => reg.requestExamples[key] ?? []

  async function loadExample(
    key: string,
    name: string,
    version: number,
  ): Promise<Example | undefined> {
    const entry = examplesOf(key).find((e) => e.name === name)
    if (!entry) return undefined
    const doc = (await entry.load(version)).default as Example
    return { ...doc, source: entry.source, dir: entry.dir }
  }

  async function readFile(path: string, dir?: string): Promise<File> {
    const url = await reg.assets[`${dir}/${norm(path)}`]?.()
    if (!url) throw new Error(`File "${path}" not found next to the example`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Could not read "${path}" (${res.status})`)
    return new File([await res.blob()], norm(path).split('/').pop() as string, {
      type: res.headers.get('content-type') ?? undefined,
    })
  }

  async function baseOptions(i: RunInput) {
    const c = await config(i.version)
    const auth = (c.auth ?? {}) as Record<string, AuthProfile>
    const serviceAuth = Object.fromEntries(
      Object.entries(c.services ?? {})
        .filter(([, s]) => s.auth)
        .map(([n, s]) => [n, s.auth as string]),
    )
    return {
      env: i.env,
      vars: {
        ...(c.vars ?? {}),
        ...(c.environments?.[i.env]?.vars ?? {}),
        ...(await environmentVars(i.env)),
      },
      overrides: i.vars,
      params: i.params,
      transport: await transportFor(i.env, i.proxyBase ?? '/__specbook/proxy', i.version),
      // placeholders stay in the request: the dev server's proxy or a static page's transport fills them
      deferSecrets: true,
      auth,
      serviceAuth,
      onEvent: i.onEvent,
      onInput: i.onInput,
      signal: i.signal,
      example: (op: { service: string; id: string }, name: string) =>
        loadExample(`${op.service}/${op.id}`, name, i.version),
      readFile: (path: string, dir?: string) => readFile(path, dir ?? i.fileDir),
    }
  }

  /** Sequences and requests with init generators or lazy data may call faker; everything else is visible. */
  async function mayUseFaker(
    target: RequestDef<any, any, any> | Sequence<any, any>,
    i: RunInput,
  ): Promise<boolean> {
    if (target.kind === 'sequence') return true
    const { init, data, example, path, query, headers } = target.input
    if (
      Object.values(init ?? {}).some((v) => typeof v === 'function') ||
      typeof data === 'function'
    )
      return true
    const base = example
      ? await loadExample(`${target.op.service}/${target.op.id}`, example, i.version)
      : undefined
    return usesFaker([base, data, target.dataPatches, path, query, headers, i.vars])
  }

  async function run(
    target: RequestDef<any, any, any> | Sequence<any, any>,
    i: RunInput,
  ): Promise<RunResult> {
    // `init` generators call faker, so it must be ready before any run unless we can see it isn't used.
    if (reg.loadFaker && (await mayUseFaker(target, i))) {
      const [mod, cfg] = await Promise.all([reg.loadFaker(i.version), config(i.version)])
      // a bundled module offers each locale as its own chunk; fetch only the ones this run falls back through
      const ready = await prepareFaker(mod, cfg.faker, i.locale)
      installFaker(ready as never, cfg.faker, { locale: i.locale, seed: i.seed })
    }
    const o = await baseOptions(i)
    if (target.kind === 'sequence') return runSequence(target, o)
    const def =
      i.mockStatus !== undefined && i.env === 'mock'
        ? target.with({ mock: { status: i.mockStatus } })
        : target
    return runRequest(def, o)
  }

  /** `base` keeps its init/capture/assert/mock; `overrides` replace path/query/headers/data. */
  async function operationRequest(
    key: string,
    version: number,
    overrides: { path?: object; query?: object; headers?: Record<string, string>; data?: unknown },
    base?: RequestDef<any, any, any>,
  ): Promise<RequestDef<any, any, any>> {
    const load = reg.operations[key]
    if (!load) throw new Error(`Unknown operation ${key}`)
    const mod = await load(version)
    const op = mod[key.split('/')[1] as string]
    if (!op) throw new Error(`Operation module for ${key} has no export`)
    const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined))
    return op.request({ ...(base?.input ?? {}), ...defined })
  }

  async function operationMeta(key: string, version: number): Promise<OpMeta | undefined> {
    const mod = await reg.operations[key]?.(version)
    return mod?.[key.split('/')[1] as string]?.meta
  }

  /** What a saved request sends, as an example: its example (if any) with its own fields merged over. */
  async function savedExample(def: RequestDef<any, any, any>, version: number): Promise<Example> {
    const key = `${def.op.service}/${def.op.id}`
    const base = def.input.example ? await loadExample(key, def.input.example, version) : undefined
    let data: unknown = def.input.data
    if (typeof data === 'function')
      data = (await (data as () => Promise<{ default: unknown }>)()).default
    let body = deepMerge<unknown>(base?.body, data)
    for (const patch of def.dataPatches) body = deepMerge(body, patch)
    return {
      name: def.input.name ?? def.op.id,
      source: 'project',
      dir: base?.dir,
      path: deepMerge(base?.path ?? {}, (def.input.path ?? {}) as Record<string, unknown>),
      query: deepMerge(base?.query ?? {}, (def.input.query ?? {}) as Record<string, unknown>),
      headers: { ...(base?.headers ?? {}), ...(def.input.headers ?? {}) },
      body,
    }
  }

  async function loadVariants(
    entries: { file: string; load: (v: number) => Promise<Record<string, any>> }[],
    version: number,
  ): Promise<Record<string, Variant[]>> {
    const out: Record<string, Variant[]> = {}
    await Promise.all(
      entries.map(async (e) => {
        try {
          const def = pickRunnable(await e.load(version))
          if (def?.kind !== 'request') return
          const key = `${def.op.service}/${def.op.id}`
          const name = def.input.name ?? e.file.replace(/^.*\//, '').replace(/\.req\.ts$/, '')
          out[key] ??= []
          out[key]?.push({ file: e.file, name, def })
        } catch {
          /* a broken request file must not break the list */
        }
      }),
    )
    for (const list of Object.values(out)) list.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  async function loadSequences(
    entries: { file: string; load: (v: number) => Promise<Record<string, any>> }[],
    version: number,
  ): Promise<SequenceInfo[]> {
    const list: SequenceInfo[] = []
    await Promise.all(
      entries.map(async (e) => {
        try {
          const seq = pickRunnable(await e.load(version))
          if (seq?.kind === 'sequence') list.push({ file: e.file, seq })
        } catch {
          /* ignore broken files */
        }
      }),
    )
    return list.sort((a, b) => a.seq.meta.title.localeCompare(b.seq.meta.title))
  }

  return {
    config,
    environments,
    environmentRisks,
    environmentNotes,
    managedSecrets,
    oauthEndpoints,
    oauthExchange,
    run,
    operationRequest,
    operationMeta,
    examplesOf,
    knownVars,
    loadExample,
    savedExample,
    loadVariants,
    loadSequences,
  }
}

export interface Variant {
  file: string
  name: string
  def: RequestDef<any, any, any>
}

export interface SequenceInfo {
  file: string
  seq: Sequence<any, any>
}

/** Default export, else the first runnable named export. */
export function pickRunnable(mod: Record<string, any>) {
  const isRun = (v: any) => v && (v.kind === 'request' || v.kind === 'sequence')
  if (isRun(mod.default)) return mod.default
  return Object.values(mod).find(isRun)
}
