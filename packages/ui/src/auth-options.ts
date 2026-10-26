import {
  type AuthProfile,
  acceptedProfiles,
  isClientCredentials,
  type OAuthClientCredentials,
  type OAuthSettings,
  resolveProfile,
  type SecurityRequirement,
  type SpecbookConfig,
  serviceProfiles,
} from '@specbook/core/internal'
import { SECRET_PLACEHOLDER } from './secrets'

/**
 * Which ways of authenticating a service offers, which of them an operation accepts, and what each still needs from the
 * person. Pure, so the credentials bar, the code sample and the tests agree.
 */

/** What the spec says an operation needs (see `OpMeta.security`). */
export type Security = boolean | SecurityRequirement[] | undefined

export type SignInSettings = Exclude<OAuthSettings, OAuthClientCredentials>

export interface AuthOption {
  /** the profile's name in the config */
  name: string
  title: string
  /** the spec scheme(s) it satisfies, when the profile says */
  schemes: string[]
  /** secrets the person can type, or sign in for */
  secrets: string[]
  /** secrets only a server fills (a client id and secret): never asked of the page */
  serverSecrets: string[]
  /** a sign-in the page can offer (the addresses may need rendering for the environment) */
  oauth?: SignInSettings
  kind: 'paste' | 'sign-in' | 'server'
}

export type Availability = 'ready' | 'sign-in' | 'paste' | 'server-missing' | 'unavailable'

const placeholders = (v: unknown): string[] => [
  ...new Set([...JSON.stringify(v ?? '').matchAll(SECRET_PLACEHOLDER)].map((m) => m[1] as string)),
]

const schemesOf = (p: AuthProfile): string[] =>
  p.scheme === undefined ? [] : Array.isArray(p.scheme) ? p.scheme : [p.scheme]

/** The ways a service lists that the config has, in the order listed (the first is the default). */
export function authOptions(
  cfg: SpecbookConfig,
  service: string,
  oauthOf: (profile: string) => OAuthSettings | undefined = (name) =>
    (cfg.auth?.[name] as AuthProfile | undefined)?.oauth,
): AuthOption[] {
  const out: AuthOption[] = []
  for (const name of serviceProfiles(cfg.services?.[service])) {
    const profile = cfg.auth?.[name] as AuthProfile | undefined
    if (!profile) continue
    const oauth = oauthOf(name) ?? profile.oauth
    const server = oauth && isClientCredentials(oauth) ? oauth : undefined
    const signIn = oauth && !isClientCredentials(oauth) ? oauth : undefined
    out.push({
      name,
      title: profile.title ?? name,
      schemes: schemesOf(profile),
      secrets: placeholders(profile.apply),
      serverSecrets: server ? placeholders([server.clientId, server.clientSecret]) : [],
      ...(signIn ? { oauth: signIn } : {}),
      kind: server ? 'server' : signIn ? 'sign-in' : 'paste',
    })
  }
  return out
}

/** `choice` first, then the others as listed: the order the runner picks from. */
export const ordered = (listed: string[], choice?: string): string[] =>
  choice && listed.includes(choice) ? [choice, ...listed.filter((n) => n !== choice)] : listed

const needsNothing = (s: Security) => s === false || (Array.isArray(s) && s.length === 0)

/** The listed profiles every one of the operations accepts: the ones a person may pick between. */
export function choosable(
  listed: string[],
  auth: Record<string, AuthProfile | undefined> | undefined,
  securities: Security[],
): string[] {
  const secured = securities.filter((s) => !needsNothing(s))
  return listed.filter(
    (n) => auth?.[n] && secured.every((s) => acceptedProfiles([n], auth, s).length > 0),
  )
}

/** The profiles the operations will use, given the person's choice: one per operation, no repeats. */
export function neededProfiles(
  listed: string[],
  auth: Record<string, AuthProfile | undefined> | undefined,
  securities: Security[],
  choice?: string,
): string[] {
  const out = new Set<string>()
  for (const security of securities) {
    const { name } = resolveProfile({ listed: ordered(listed, choice), auth, security })
    if (name) out.add(name)
  }
  return [...out]
}

/** The schemes the spec wants for operations that none of the listed profiles accepts (empty when all are served). */
export function unservedSchemes(
  listed: string[],
  auth: Record<string, AuthProfile | undefined> | undefined,
  securities: Security[],
): string[] {
  const wants = new Set<string>()
  for (const s of securities)
    if (Array.isArray(s) && s.length && !acceptedProfiles(listed, auth, s).length)
      for (const r of s) for (const n of Object.keys(r)) wants.add(n)
  return [...wants]
}

/** Where an option stands: ready to use, or what the person (or the server) still has to supply. */
export function availability(
  o: AuthOption,
  have: (secret: string) => boolean,
  serverHas: (secret: string) => boolean,
  hasServer: boolean,
): Availability {
  if (o.kind === 'server') {
    if (!hasServer) return 'unavailable'
    return o.serverSecrets.every(serverHas) ? 'ready' : 'server-missing'
  }
  if (o.secrets.every(have)) return 'ready'
  return o.kind === 'sign-in' ? 'sign-in' : 'paste'
}

export const STATUS: Record<Availability, string> = {
  ready: '✓',
  'sign-in': 'sign in',
  paste: 'paste',
  'server-missing': 'set on server',
  unavailable: 'needs a server',
}
