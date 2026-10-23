import type { SecurityRequirement } from '../types'
import type { AuthProfile } from './run'

/**
 * Which auth profile an operation uses. Pure, so the runner, `specbook check` and the UI agree.
 *
 * A profile that names the spec scheme(s) it satisfies (`scheme`) is accepted by an operation when one of the operation's
 * requirements is covered by them. An operation whose requirements are unknown (older generated code, `security: true`),
 * or a profile with no `scheme`, cannot be told apart, so it is accepted.
 */

export type ProfileReason = 'explicit' | 'accepted' | 'default'

/** The requirements as a list, or undefined when the operation carries no scheme information. */
export function requirementsOf(
  security: boolean | SecurityRequirement[] | undefined,
): SecurityRequirement[] | undefined {
  return Array.isArray(security) ? security : undefined
}

const schemesOf = (p: Pick<AuthProfile, 'scheme'> | undefined): string[] | undefined =>
  p?.scheme === undefined ? undefined : Array.isArray(p.scheme) ? p.scheme : [p.scheme]

/** True when the profile's schemes cover every scheme of the requirement (a requirement with none matches nothing). */
export function satisfies(
  profile: Pick<AuthProfile, 'scheme'> | undefined,
  req: SecurityRequirement,
): boolean {
  const have = schemesOf(profile)
  const need = Object.keys(req)
  if (!have || need.length === 0) return false
  return need.every((n) => have.includes(n))
}

/** The listed profiles an operation accepts, in the order listed. */
export function acceptedProfiles(
  listed: string[],
  auth: Record<string, Pick<AuthProfile, 'scheme'> | undefined> | undefined,
  security: boolean | SecurityRequirement[] | undefined,
): string[] {
  const known = listed.filter((n) => auth?.[n])
  const reqs = requirementsOf(security)
  if (!reqs || reqs.length === 0) return known
  // a profile that does not say which scheme it satisfies can stand in for any
  return known.filter(
    (n) => schemesOf(auth?.[n]) === undefined || reqs.some((r) => satisfies(auth?.[n], r)),
  )
}

/** The profile a request uses: its own choice, else the first listed one the operation accepts, else the default. */
export function resolveProfile(i: {
  explicit?: string | false
  listed: string[]
  auth: Record<string, Pick<AuthProfile, 'scheme'> | undefined> | undefined
  security: boolean | SecurityRequirement[] | undefined
}): { name?: string; reason?: ProfileReason } {
  if (i.security === false || (Array.isArray(i.security) && i.security.length === 0)) return {}
  if (i.explicit === false) return {}
  if (i.explicit !== undefined)
    return i.auth?.[i.explicit] ? { name: i.explicit, reason: 'explicit' } : {}
  const accepted = acceptedProfiles(i.listed, i.auth, i.security)[0]
  if (accepted) {
    // the first listed profile is the default; "accepted" says an operation steered the choice away from it
    return {
      name: accepted,
      reason: accepted === i.listed.find((n) => i.auth?.[n]) ? 'default' : 'accepted',
    }
  }
  const first = i.listed.find((n) => i.auth?.[n])
  return first ? { name: first, reason: 'default' } : {}
}
