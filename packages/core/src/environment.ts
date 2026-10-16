// Where an environment's calls go: base URLs and sign-in endpoints are templates over the environment's
// variables (config `vars`, then `environments.<env>.vars`, then the environment's own file).

import type { SpecbookConfig } from './config'
import type { OAuthSettings } from './oauth'
import {
  collectPlaceholders,
  isDeferred,
  isFakerName,
  renderString,
  TemplateError,
} from './template'

/** An address (base URL or sign-in endpoint) that cannot be worked out for an environment. */
export class AddressError extends Error {
  constructor(
    message: string,
    /** the variable to set, when that is what is missing */
    readonly variable?: string,
  ) {
    super(message)
    this.name = 'AddressError'
  }
}

type AddressConfig = Pick<SpecbookConfig, 'vars' | 'environments' | 'services'> & {
  auth?: Record<string, { oauth?: OAuthSettings }>
}

/** Fields of an OAuth profile that are templates; `scopes` and the rest stay as written. */
export const OAUTH_ADDRESS_FIELDS = [
  'authorizationUrl',
  'tokenUrl',
  'openIdConnectUrl',
  'clientId',
] as const

/**
 * The variables an environment's addresses are rendered with, later wins:
 * config `vars` → `environments.<env>.vars` → the environment's file (→ browser store, via `extra`).
 * Per-run values (overrides, captures) deliberately take no part: the dev server has to reach the same
 * answer as the page.
 */
export function environmentScope(
  cfg: Pick<SpecbookConfig, 'vars' | 'environments'>,
  env: string,
  fileVars: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...cfg.vars,
    ...(cfg.environments as Record<string, { vars?: Record<string, unknown> }> | undefined)?.[env]
      ?.vars,
    ...fileVars,
    ...extra,
  }
}

/** Renders an address template with plain variables only; secrets and faker values have no place in one. */
function renderAddress(template: string, scope: Record<string, unknown>, what: string): string {
  for (const name of collectPlaceholders(template)) {
    if (isDeferred(name) || isFakerName(name))
      throw new AddressError(
        `${what} cannot use {{${name}}}: only environment variables are available`,
      )
  }
  let value: unknown
  try {
    value = renderString(template, scope)
  } catch (e) {
    if (e instanceof TemplateError) throw new AddressError(`${what}: set ${e.variable}`, e.variable)
    throw e
  }
  if (value !== null && typeof value === 'object')
    throw new AddressError(`${what} is not a text value`)
  const out = value === undefined || value === null ? '' : String(value).trim()
  if (/\{\{/.test(out)) throw new AddressError(`${what} still contains a placeholder: ${out}`)
  return out
}

/**
 * The address calls for `service` go to in `env`, without a trailing slash; `undefined` when there is none.
 * A string `baseUrl` is a template over `scope`; a record is read by environment name (and may use variables
 * too).
 */
export function baseUrlFor(
  cfg: Pick<SpecbookConfig, 'services'>,
  service: string,
  env: string,
  scope: Record<string, unknown>,
): string | undefined {
  const base = cfg.services[service]?.baseUrl as
    | string
    | Record<string, string | undefined>
    | undefined
  const template = typeof base === 'string' ? base : base?.[env]
  if (!template) return undefined
  const what = `No base URL for ${service} in ${env}`
  const url = /\{\{/.test(template) ? renderAddress(template, scope, what) : template.trim()
  return url ? url.replace(/\/+$/, '') : undefined
}

/** `oauth` with its address fields rendered; `scopes` and everything else as written. */
export function oauthFor<T extends OAuthSettings>(
  oauth: T,
  scope: Record<string, unknown>,
  profile = 'sign-in',
): T {
  const out: Record<string, unknown> = { ...oauth }
  for (const field of OAUTH_ADDRESS_FIELDS) {
    const v = out[field]
    if (typeof v !== 'string' || !/\{\{/.test(v)) continue
    const rendered = renderAddress(v, scope, `${profile} ${field}`)
    if (rendered) out[field] = rendered
    else delete out[field]
  }
  return out as T
}

/**
 * Every environment name, in the order the pickers show them: `mock`, `live` (when a service has a string
 * `baseUrl` or a `live` address), the record keys, `environments`, then environment files and `extra` (the
 * browser's own environments).
 */
export function environmentNames(
  cfg: Pick<SpecbookConfig, 'environments' | 'services'>,
  fileEnvs: Iterable<string> = [],
  extra: Iterable<string> = [],
): string[] {
  const names = new Set<string>(['mock'])
  const services = Object.values(cfg.services ?? {})
  if (services.some((s) => typeof s.baseUrl === 'string')) names.add('live')
  for (const s of services) {
    if (s.baseUrl && typeof s.baseUrl === 'object')
      for (const k of Object.keys(s.baseUrl)) names.add(k)
  }
  for (const k of Object.keys(cfg.environments ?? {})) names.add(k)
  for (const k of fileEnvs) names.add(k)
  for (const k of extra) names.add(k)
  return [...names]
}

/** True when `url` is an absolute http(s) address. */
export const isAbsoluteHttp = (url: string): boolean => /^https?:\/\/[^\s/]/i.test(url)

export interface AddressUse {
  services: string[]
  profiles: { profile: string; field: (typeof OAUTH_ADDRESS_FIELDS)[number] }[]
}

/** Which base URLs and sign-in fields read each variable: what a variable is "for" in an environment. */
export function addressUses(cfg: AddressConfig): Record<string, AddressUse> {
  const out: Record<string, AddressUse> = {}
  const use = (name: string) => {
    if (isDeferred(name) || isFakerName(name)) return undefined
    out[name] ??= { services: [], profiles: [] }
    return out[name]
  }
  for (const [service, s] of Object.entries(cfg.services ?? {})) {
    const templates = typeof s.baseUrl === 'string' ? [s.baseUrl] : Object.values(s.baseUrl ?? {})
    for (const t of templates)
      for (const name of collectPlaceholders(t)) {
        const u = use(name)
        if (u && !u.services.includes(service)) u.services.push(service)
      }
  }
  for (const [profile, p] of Object.entries(cfg.auth ?? {})) {
    for (const field of OAUTH_ADDRESS_FIELDS) {
      const v = (p.oauth as Record<string, unknown> | undefined)?.[field]
      if (typeof v !== 'string') continue
      for (const name of collectPlaceholders(v)) use(name)?.profiles.push({ profile, field })
    }
  }
  return out
}
