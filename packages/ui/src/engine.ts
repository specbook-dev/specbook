// Run orchestration for the UI. Pure TS (no DOM) so it can be unit-tested with a fake registry.
import {
  AddressError,
  AUTH_SERVICE_PREFIX,
  type AuthProfile,
  absoluteBase,
  addressUses,
  authServiceName,
  baseUrlFor,
  createFetchTransport,
  createMockTransport,
  DISCOVERY_SERVICE_PREFIX,
  type DiscoveredEndpoints,
  deepMerge,
  type Example,
  environmentNames,
  environmentScope,
  installFaker,
  isClientCredentials,
  isDiscovery,
  type OAuthSettings,
  type OpMeta,
  oauthFor,
  parseDiscovery,
  prepareFaker,
  type RequestDef,
  type RunEvent,
  type RunResult,
  runRequest,
  runSequence,
  type ScriptHost,
  type Sequence,
  type SpecbookConfig,
  scriptFlow,
  serviceProfiles,
  setFaker,
  type Transport,
  usesFaker,
  withMock,
} from '@specbook/core/internal'
import { ordered } from './auth-options'
import { corsHint, READS, willPreflight } from './cors'
import type { EnvironmentStore } from './custom-environments'
import {
  type ExtensionBridge,
  extensionLevel,
  extensionTransport,
  WireError,
  wireGrant,
  wireStatus,
} from './extension'
import { routingTransport, withPageSecrets } from './routing'
import { browserScriptHost } from './script-host'
import { originOf, type SecretStore, secretStore } from './secrets'

/**
 * A sign-in's token exchange is addressed to the reserved service `auth:<profile>`: the dev server's proxy answers it from
 * the profile's own `oauth.tokenUrl`. Likewise for an OpenID Connect discovery document, whose host may differ from the
 * token endpoint's.
 */
const authService = authServiceName
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
  /** Said when a run uses `{{faker.*}}` and there is no faker (the hosted viewer ships none). */
  fakerUnavailable?: string
  mode?: 'dev' | 'static'
  /** variables from `.specbook/environments/<env>.env`, baked in at build time */
  environmentVars?: Record<string, Record<string, string>>
}

export interface RunInput {
  env: string
  version: number
  /** Forced mock status per run (mock env only). */
  mockStatus?: number
  /** With `mockStatus`: the variant of that status that answers, by name. */
  mockVariant?: string
  inputs?: Record<string, unknown>
  vars?: Record<string, unknown>
  onEvent?: (e: RunEvent) => void
  onInput?: Parameters<typeof runSequence>[1]['onInput']
  signal?: AbortSignal
  /** Makes the container a script step renders into (the panel); without it a script that needs one fails. */
  mount?: ScriptHost['mount']
  proxyBase?: string
  locale?: string
  seed?: number
  /** Folder upload paths are relative to when the request was not built from a named example. */
  fileDir?: string
}

/** One variable of an environment as the settings show it. */
export interface VariableRow {
  name: string
  value: string
  /** where the value comes from: the config's defaults or the environment's section, a file, this browser */
  source: 'default' | 'config' | 'file' | 'browser'
  /** what the variable falls back to when its own value is removed; undefined when it has no other */
  fallback?: string
  /** whether the value can be edited here */
  editable: boolean
}

export interface EnvironmentView {
  rows: VariableRow[]
  /** where each service's calls go in this environment, or why they cannot */
  addresses: { service: string; url?: string; error?: string }[]
  /** which services' addresses and profiles' sign-in fields read each variable */
  uses: ReturnType<typeof addressUses>
  /** a browser-made environment: it can be deleted */
  removable: boolean
}

export interface EngineOptions {
  /** The bridge to the browser extension when it is installed and enabled for this page. */
  extension?: () => Promise<ExtensionBridge | undefined>
  /** Where the person's typed secrets are kept (the page's store by default). */
  secrets?: SecretStore
  /** Environments made in this browser (a static page has no files to write them to). */
  environmentStore?: EnvironmentStore
  /** The auth profile the person picked for a service, tried before the others the operation accepts. */
  authChoice?: (service: string) => string | undefined
}

const ENV_NAME = /^[A-Za-z0-9_-]+$/
const VAR_NAME = /^[A-Za-z_][\w.-]*$/
const hasTemplate = (v: unknown): boolean =>
  typeof v === 'string'
    ? /\{\{/.test(v)
    : v !== null && typeof v === 'object' && Object.values(v).some(hasTemplate)
const text = (v: unknown) =>
  v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')

export { willPreflight }

export function createEngine(reg: Registry, opts: EngineOptions = {}) {
  // no faker to load: a `{{faker.*}}` ends the run with the registry's message, not "install @faker-js/faker"
  if (!reg.loadFaker && reg.fakerUnavailable) {
    const message = reg.fakerUnavailable
    setFaker(
      new Proxy(
        {},
        {
          get() {
            throw new Error(message)
          },
        },
      ),
    )
  }
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

  const isStaticPage = () => reg.mode !== 'dev'
  const browserEnvs = () => (isStaticPage() ? (opts.environmentStore?.all() ?? {}) : {})
  // dev: environments created this session, until the registry reloads with their files
  const createdHere = new Set<string>()

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
    // a copy is as careful as what it was copied from
    for (const [name, b] of Object.entries(browserEnvs()))
      if (b.from && out[b.from] && !out[name]) out[name] = out[b.from] as 'production' | 'sandbox'
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
    for (const [name, b] of Object.entries(browserEnvs()))
      if (b.from) out[name] = `copy of ${b.from}, kept in this browser`
    return out
  }

  async function environments(version: number): Promise<string[]> {
    const c = await config(version)
    return environmentNames(
      { services: c.services ?? {}, environments: c.environments },
      [...Object.keys(reg.environmentVars ?? {}), ...createdHere],
      Object.keys(browserEnvs()),
    )
  }

  /**
   * The environment's own variables: read live from the dev server; baked in for a static build, with
   * the ones this browser holds over them.
   */
  async function environmentVars(env: string): Promise<Record<string, string>> {
    if (reg.mode === 'dev') {
      try {
        const r = await fetch(`/__specbook/environment?env=${encodeURIComponent(env)}`)
        if (r.ok) return ((await r.json()) as { vars: Record<string, string> }).vars
      } catch {
        /* fall back to what was baked in */
      }
    }
    return { ...reg.environmentVars?.[env], ...browserEnvs()[env]?.vars }
  }

  /** What an address is rendered with: defaults, the environment's own settings, its file or browser copy. */
  async function scopeOf(env: string, version: number): Promise<Record<string, unknown>> {
    return environmentScope(await config(version), env, await environmentVars(env))
  }

  /** Where `service`'s calls go in `env`; undefined when it has no address there. Throws an AddressError. */
  async function baseUrlOf(service: string, env: string, version: number) {
    return baseUrlFor(await config(version), service, env, await scopeOf(env, version))
  }

  /** A profile's sign-in settings with its address fields rendered for `env`. */
  async function oauthOf(
    profile: string,
    env: string,
    version: number,
  ): Promise<OAuthSettings | undefined> {
    const oauth = ((await config(version)).auth?.[profile] as AuthProfile | undefined)?.oauth
    // nothing to render, so nothing to ask the dev server for
    if (!oauth || !hasTemplate(oauth)) return oauth
    return oauthFor(oauth, await scopeOf(env, version), profile)
  }

  /**
   * Addresses for a config the caller already holds (a page reading `engine.config` once for several
   * services): the same rendering as `baseUrlOf` / `oauthOf`, with an address that cannot be worked out
   * left undefined. The environment's variables are fetched only when something is written as a template.
   */
  async function addressesIn(cfg: SpecbookConfig, env: string) {
    const templated =
      Object.values(cfg.services ?? {}).some((s) => hasTemplate(s.baseUrl)) ||
      Object.values(cfg.auth ?? {}).some((p) => hasTemplate((p as AuthProfile).oauth))
    const scope = environmentScope(cfg, env, templated ? await environmentVars(env) : {})
    return {
      baseUrl(service: string): string | undefined {
        try {
          return baseUrlFor(cfg, service, env, scope)
        } catch {
          return undefined
        }
      },
      oauth(profile: string): OAuthSettings | undefined {
        const oauth = (cfg.auth?.[profile] as AuthProfile | undefined)?.oauth
        try {
          return oauth ? oauthFor(oauth, scope, profile) : undefined
        } catch {
          return undefined
        }
      },
    }
  }

  /** The environment's variables as the settings show them, and where each service's calls go. */
  async function environmentView(env: string, version: number): Promise<EnvironmentView> {
    const c = await config(version)
    const defaults = c.vars ?? {}
    const section =
      (c.environments?.[env] as { vars?: Record<string, unknown> } | undefined)?.vars ?? {}
    const stored = browserEnvs()[env]
    const baked = isStaticPage() ? (reg.environmentVars?.[env] ?? {}) : await environmentVars(env)
    const browser = stored?.vars ?? {}
    const names = [
      ...new Set([
        ...Object.keys(defaults),
        ...Object.keys(section),
        ...Object.keys(baked),
        ...Object.keys(browser),
      ]),
    ]
    const editable = reg.mode === 'dev' || !!opts.environmentStore
    const rows: VariableRow[] = names.map((name) => {
      const inherited = name in section ? section[name] : defaults[name]
      const own = name in browser ? 'browser' : name in baked ? 'file' : undefined
      const value = name in browser ? browser[name] : name in baked ? baked[name] : inherited
      const fallbackSource = name in browser && name in baked ? baked[name] : inherited
      return {
        name,
        value: text(value),
        source: own ?? (name in section ? 'config' : 'default'),
        fallback: own && fallbackSource !== undefined ? text(fallbackSource) : undefined,
        editable,
      }
    })
    const scope = environmentScope(c, env, { ...baked, ...browser })
    const addresses: EnvironmentView['addresses'] = []
    if (env !== 'mock')
      for (const service of Object.keys(c.services ?? {})) {
        try {
          const url = baseUrlFor(c, service, env, scope)
          addresses.push({ service, ...(url ? { url } : {}) })
        } catch (e) {
          if (!(e instanceof AddressError)) throw e
          addresses.push({ service, error: e.message })
        }
      }
    return { rows, addresses, uses: addressUses(c), removable: !!stored?.from }
  }

  /** Whether a person can make environments here: the dev server writes a file, a static page keeps it. */
  const canCreateEnvironment = () => reg.mode === 'dev' || !!opts.environmentStore

  /** A new environment holding a copy of `from`'s own variables (never its secrets). */
  async function createEnvironment(name: string, from: string, version: number): Promise<void> {
    if (!ENV_NAME.test(name))
      throw new Error('Use letters, digits, "-" and "_" in an environment name')
    if (name === 'mock' || (await environments(version)).includes(name))
      throw new Error(`"${name}" already exists`)
    if (reg.mode === 'dev') {
      const r = await fetch('/__specbook/environment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, from }),
      })
      if (!r.ok)
        throw new Error(((await r.json()) as { error?: string }).error ?? 'could not create')
      createdHere.add(name)
      return
    }
    if (!opts.environmentStore) throw new Error('This page has nowhere to keep a new environment')
    const c = await config(version)
    const section =
      (c.environments?.[from] as { vars?: Record<string, unknown> } | undefined)?.vars ?? {}
    const own = { ...section, ...(await environmentVars(from)) }
    opts.environmentStore.save(name, {
      from,
      vars: Object.fromEntries(
        Object.entries(own)
          .filter(([, v]) => v !== null && typeof v !== 'object')
          .map(([k, v]) => [k, String(v)]),
      ),
    })
  }

  /** Sets (or, with `null`, removes) one of an environment's own variables. */
  async function setVariable(env: string, name: string, value: string | null): Promise<void> {
    if (!VAR_NAME.test(name)) throw new Error(`"${name}" is not a variable name`)
    if (reg.mode === 'dev') {
      const r = await fetch('/__specbook/var', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ env, name, value }),
      })
      if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? 'save failed')
      return
    }
    const store = opts.environmentStore
    if (!store) throw new Error('This page has nowhere to keep a variable')
    const current = store.all()[env] ?? { vars: {} }
    const vars = { ...current.vars }
    if (value === null) delete vars[name]
    else vars[name] = value
    if (!current.from && Object.keys(vars).length === 0) store.remove(env)
    else store.save(env, { ...current, vars })
  }

  /** Forgets an environment made in this browser. */
  function deleteEnvironment(env: string): void {
    opts.environmentStore?.remove(env)
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
    // the environment's variables are only fetched when an address is written as a template
    const templated = Object.values(cfg.services ?? {}).some((s) => hasTemplate(s.baseUrl))
    const scope = templated ? await scopeOf(env, version) : {}
    const pageHref = globalThis.location?.href
    const pageOrigin = globalThis.location?.origin
    const baseOf = (service: string) => {
      if (extra[service]) return extra[service]
      let url: string | undefined
      try {
        url = baseUrlFor(cfg, service, env, scope)
      } catch (e) {
        if (e instanceof AddressError) throw new Error(e.message)
        throw e
      }
      if (!url) throw new Error(`No base URL for ${service} in ${env}`)
      return absoluteBase(url, pageHref)
    }
    const hasProxy = reg.mode !== 'static'
    const bridge = await opts.extension?.()
    // an extension from before the current protocol is not sent calls it may mishandle; the person is told
    const level = bridge ? extensionLevel(bridge) : undefined
    const ext = bridge && level === 'ready' ? extensionTransport(bridge, safeBase) : undefined
    const store = opts.secrets ?? secretStore

    const direct = createFetchTransport({ baseUrl: baseOf })
    const viaProxy = hasProxy
      ? createFetchTransport({ baseUrl: (service) => `${proxyBase}/${env}/${service}` })
      : undefined
    const plain = withPageSecrets(direct, { store, originFor, unresolved: 'fail' })
    const routed = routingTransport({
      direct: guardCors(plain),
      proxy: viaProxy
        ? withPageSecrets(viaProxy, { store, originFor, unresolved: 'keep' })
        : undefined,
      extension: ext
        ? directFirst(withPageSecrets(ext, { store, originFor, unresolved: 'fail' }), plain)
        : undefined,
      baseOf: safeBase,
      pageOrigin,
    })
    return routed

    /**
     * A call to an API the person has not allowed yet is tried straight from the page first, as it was
     * before the extension was installed: one that sends CORS headers just works. Only when that is blocked
     * too does the call fail with the offer to allow it (the extension's own refusal, not the bare CORS
     * error). A change a browser would send without asking the API first (a plain POST) is not tried that
     * way: the API would act on it even though the page never sees the answer.
     */
    function directFirst(viaExtension: Transport, straight: Transport): Transport {
      return async (req, signal) => {
        try {
          return await viaExtension(req, signal)
        } catch (e) {
          if (
            !(e instanceof WireError) ||
            e.code !== 'not-allowed' ||
            !(READS.has(req.method.toUpperCase()) || willPreflight(req))
          )
            throw e
          try {
            return await straight(req, signal)
          } catch (blocked) {
            if (blocked instanceof TypeError) throw e
            throw blocked
          }
        }
      }
    }
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
          if (!(e instanceof TypeError)) throw e
          const sentToIdp =
            req.service.startsWith(AUTH_SERVICE_PREFIX) ||
            req.service.startsWith(DISCOVERY_SERVICE_PREFIX)
          const target = originOf(extra[req.service] ?? safeBase(req.service))
          const message = sentToIdp
            ? `The browser could not reach the sign-in provider (${extra[req.service] ?? 'unknown'}). It probably does not allow calls from this page (CORS). Embedding the viewer on the API's origin does not help when the sign-in server is on another host. You can still paste an access token.`
            : `The browser could not reach ${req.service} in "${env}". The API probably does not allow calls from this page (CORS). It works when the viewer runs on the API's own origin: embed it in the API's docs route ("Embed the viewer" in the README). Mock data keeps working.`
          // what the page can offer, said where this failure is shown (not for the page's own origin: that is no CORS)
          const hint = corsHint(target, pageOrigin, level)
          throw Object.assign(new Error(message), hint ? { hint } : {})
        }
      }
    }
  }

  /**
   * What the extension means for this environment. `none`: nothing cross-origin to call, or a proxy does it.
   * Otherwise the origins this page would need it for, and which of them the person has not allowed yet.
   */
  async function extensionState(
    env: string,
    version: number,
    services?: string[],
  ): Promise<{
    state: 'none' | 'absent' | 'outdated' | 'ready'
    needed: string[]
    missing: string[]
  }> {
    if (env === 'mock' || reg.mode !== 'static') return { state: 'none', needed: [], missing: [] }
    const cfg = await config(version)
    const pageHref = globalThis.location?.href
    const pageOrigin = globalThis.location?.origin
    const origins = new Set<string>()
    const addresses = await addressesIn(cfg, env)
    for (const name of services ?? Object.keys(cfg.services ?? {})) {
      const svc = cfg.services?.[name]
      const base = addresses.baseUrl(name)
      const api = originOf(base ? absoluteBase(base, pageHref) : undefined)
      if (api && api !== pageOrigin) origins.add(api)
      // the sign-in provider is another origin this page calls on the person's behalf
      const oauth = serviceProfiles(svc)
        .map((p) => (cfg.auth?.[p] as AuthProfile | undefined)?.oauth)
        .find((o) => o && !isClientCredentials(o))
      const idp = oauth
        ? originOf(
            isDiscovery(oauth)
              ? oauth.openIdConnectUrl
              : isClientCredentials(oauth)
                ? undefined
                : (oauth.tokenUrl ?? oauth.authorizationUrl),
          )
        : undefined
      if (idp && idp !== pageOrigin) origins.add(idp)
    }
    const needed = [...origins]
    if (needed.length === 0) return { state: 'none', needed, missing: [] }
    const bridge = await opts.extension?.()
    if (!bridge) return { state: 'absent', needed, missing: needed }
    if (extensionLevel(bridge) === 'outdated') return { state: 'outdated', needed, missing: needed }
    const { missing } = await wireStatus(bridge, needed)
    return { state: 'ready', needed, missing }
  }

  /** Ask the extension to put these origins in front of the person. */
  async function requestExtensionGrant(origins: string[], what?: { writes?: boolean }) {
    const bridge = await opts.extension?.()
    if (!bridge) return { granted: [] as string[], missing: origins }
    return wireGrant(bridge, origins, what)
  }

  /** Whether a server (the dev server, or a hosted proxy) stands behind this page and can hold secrets for it. */
  const hasServer = () => reg.mode !== 'static'

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

  type SignInEndpoints = Omit<DiscoveredEndpoints, 'tokenUrl'> & {
    scopes: Record<string, string>
    /** absent for the implicit flow, whose token comes back in the address */
    tokenUrl?: string
    flow?: 'authorizationCode' | 'implicit'
  }
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
    let oauth: OAuthSettings | undefined
    try {
      oauth = await oauthOf(i.profile, i.env, i.version)
    } catch (e) {
      if (e instanceof AddressError) throw new Error(e.message)
      throw e
    }
    if (!oauth || isClientCredentials(oauth))
      throw new Error(`"${i.profile}" has no sign-in configured`)
    if (!isDiscovery(oauth))
      return {
        authorizationUrl: oauth.authorizationUrl,
        ...(oauth.tokenUrl ? { tokenUrl: oauth.tokenUrl } : {}),
        flow: oauth.flow ?? 'authorizationCode',
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
      flow: 'authorizationCode',
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
    if (!tokenUrl)
      throw new Error(`"${i.profile}" signs in with the implicit flow: there is no token exchange`)
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
        .filter(([, s]) => serviceProfiles(s).length)
        .map(([n, s]) => [n, ordered(serviceProfiles(s), opts.authChoice?.(n))]),
    )
    const vars = await scopeOf(i.env, i.version)
    // a client credentials profile fetches its token as the reserved service `auth:<profile>`, at its token endpoint
    const tokenOrigins: Record<string, string> = {}
    if (i.env !== 'mock')
      for (const [name, p] of Object.entries(auth)) {
        if (!p.oauth || !isClientCredentials(p.oauth)) continue
        try {
          tokenOrigins[authService(name)] = new URL(oauthFor(p.oauth, vars, name).tokenUrl).origin
        } catch {
          /* the run says the address cannot be worked out */
        }
      }
    return {
      env: i.env,
      vars,
      overrides: i.vars,
      inputs: i.inputs,
      transport: await transportFor(
        i.env,
        i.proxyBase ?? '/__specbook/proxy',
        i.version,
        tokenOrigins,
      ),
      // a script's `fetch` goes through the extension like a request does, but never the dev proxy, which only knows the
      // project's own APIs (a request step calls those, with their credentials)
      scripts: await scriptHost(i),
      // placeholders stay in the request: the dev server's proxy or a static page's transport fills them
      deferSecrets: true,
      auth,
      serviceAuth,
      onEvent: i.onEvent,
      onInput: i.onInput,
      signal: i.signal,
      // the project's own, else the runner's default
      timeoutMs: c.timeoutMs,
      example: (op: { service: string; id: string }, name: string) =>
        loadExample(`${op.service}/${op.id}`, name, i.version),
      readFile: (path: string, dir?: string) => readFile(path, dir ?? i.fileDir),
    }
  }

  /** What script steps run on in a page. The mock environment answers a script with its mock, so it asks no one. */
  async function scriptHost(i: RunInput): Promise<ScriptHost> {
    const bridge = i.env === 'mock' ? undefined : await opts.extension?.()
    return browserScriptHost({
      bridge,
      level: bridge ? extensionLevel(bridge) : undefined,
      pageOrigin: globalThis.location?.origin,
      mount: i.mount,
    })
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

  /**
   * Makes faker ready for `locale` (a bundled module offers each locale as its own chunk, so only the ones it falls back
   * through are fetched). Generated values need it before a run: a form that offers one asks for it when it opens.
   */
  async function fakerReady(version: number, locale?: string, seed?: number): Promise<boolean> {
    if (!reg.loadFaker) return false
    const [mod, cfg] = await Promise.all([reg.loadFaker(version), config(version)])
    const ready = await prepareFaker(mod, cfg.faker, locale)
    installFaker(ready as never, cfg.faker, { locale, seed })
    return true
  }

  async function run(
    target: RequestDef<any, any, any> | Sequence<any, any>,
    i: RunInput,
  ): Promise<RunResult> {
    // `init` generators call faker, so it must be ready before any run unless we can see it isn't used.
    if (reg.loadFaker && (await mayUseFaker(target, i)))
      await fakerReady(i.version, i.locale, i.seed)
    const o = await baseOptions(i)
    if (target.kind === 'sequence') return runSequence(target, o)
    return runRequest(
      target,
      i.env === 'mock' ? { ...o, mockStatus: i.mockStatus, mockVariant: i.mockVariant } : o,
    )
  }

  /** `base` keeps its init/capture/assert and mock hook; `overrides` replace path/query/headers/data. */
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
    const made = op.request({ ...(base?.input ?? {}), ...defined })
    return base?.mockHook ? withMock(made, base.mockHook) : made
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
          if (seq?.kind === 'script') list.push({ file: e.file, seq: scriptFlow(seq) })
          else if (seq?.kind === 'sequence') list.push({ file: e.file, seq })
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
    environmentVars,
    environmentView,
    canCreateEnvironment,
    createEnvironment,
    deleteEnvironment,
    setVariable,
    baseUrlOf,
    oauthOf,
    addressesIn,
    managedSecrets,
    hasServer,
    extensionState,
    requestExtensionGrant,
    oauthEndpoints,
    oauthExchange,
    run,
    fakerReady,
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
  const isRun = (v: any) =>
    v && (v.kind === 'request' || v.kind === 'sequence' || v.kind === 'script')
  if (isRun(mod.default)) return mod.default
  return Object.values(mod).find(isRun)
}
