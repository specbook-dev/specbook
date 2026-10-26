import {
  baseUrlFor,
  environmentNames,
  environmentScope,
  type OAuthSettings,
  oauthFor,
  type SpecbookConfig,
} from '@specbook/core/internal'
import type { EnvironmentAddresses } from './proxy'

export type AddressConfig = Omit<Partial<SpecbookConfig>, 'auth'> & {
  auth?: Record<string, { oauth?: OAuthSettings }>
}

export const NO_ADDRESSES: EnvironmentAddresses = {
  services: {},
  tokenOrigins: {},
  discoveryOrigins: {},
}

/**
 * Where `env`'s calls may go, from the project's config and the environment's files alone: the page never
 * says where to go. An environment the project does not have gets nothing (a 404 at the proxy).
 * `tokenOriginOf` finds the token endpoint of an OpenID Connect discovery document.
 */
export async function addressesFor(
  cfg: AddressConfig,
  env: string,
  files: { environments: string[]; vars(): Promise<Record<string, unknown>> },
  tokenOriginOf: (discoveryUrl: string) => Promise<string | undefined>,
): Promise<EnvironmentAddresses> {
  const services = cfg.services ?? {}
  const known = environmentNames({ services, environments: cfg.environments }, files.environments)
  if (!known.includes(env)) return NO_ADDRESSES
  const scope = environmentScope(cfg, env, await files.vars())
  const out: EnvironmentAddresses = { services: {}, tokenOrigins: {}, discoveryOrigins: {} }
  for (const [name, svc] of Object.entries(services)) {
    // `mock` never leaves the page: a template's defaults are not its address
    if (env === 'mock' && typeof svc.baseUrl === 'string') continue
    try {
      out.services[name] = baseUrlFor({ services }, name, env, scope)
    } catch {
      /* no address in this environment: a call gets a 404 saying so */
    }
  }
  for (const [name, profile] of Object.entries(cfg.auth ?? {})) {
    try {
      if (!profile.oauth) continue
      const oauth = oauthFor(profile.oauth, scope, name)
      if ('tokenUrl' in oauth && oauth.tokenUrl)
        out.tokenOrigins[name] = new URL(oauth.tokenUrl).origin
      else if ('openIdConnectUrl' in oauth && oauth.openIdConnectUrl) {
        out.discoveryOrigins[name] = new URL(oauth.openIdConnectUrl).origin
        const token = await tokenOriginOf(oauth.openIdConnectUrl)
        if (token) out.tokenOrigins[name] = token
      }
    } catch {
      /* an unusable address is left out; a sign-in against it fails with a 404 */
    }
  }
  return out
}
