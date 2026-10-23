import type { SpecCredentials } from '@specbook/core'

/**
 * The credentials `specbook add` writes into a project's config: `secrets`, an `auth` profile for each way the spec accepts,
 * and `auth: '<profile>'` (or a list, the default first) on the service. The config is edited as text, like the rest of `add`, so what a person wrote stays as they wrote it: a
 * block that is there is added to at the top, a block that is not is made before `services`, and a name that is already
 * there is left alone.
 */

export const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const key = (k: string) => (IDENTIFIER.test(k) ? k : quote(k))

type Profile = SpecCredentials['profiles'][number]

export interface CredentialPlan {
  /** the profiles to write, the default first, which the service names as its `auth`; none when nothing is written */
  profiles: Profile[]
  /** secrets that are not in the config yet */
  add: string[]
  /** secrets the config already declares */
  reused: string[]
  /** what to tell the person, from the spec and from what the config already holds */
  notes: string[]
  /** the config has a shape that is not safe to edit (a block that is not a literal): print the snippet instead */
  manual: boolean
  /** the indentation of the config's top level, and one step of it */
  top: string
  step: string
}

interface Block {
  open: number
  close: number
  keys: string[]
  multiline: boolean
}

/** The `{ ... }` that starts at `open`: where it ends, and the names it holds at its own level. */
function scanObject(text: string, open: number): Omit<Block, 'multiline'> | undefined {
  let depth = 0
  let expectKey = false
  const keys: string[] = []
  for (let i = open; i < text.length; i++) {
    const c = text[i] as string
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      if (end < 0) return undefined
      i = end
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) return undefined
      i = end + 1
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const start = i
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++
      if (i >= text.length) return undefined
      if (depth === 1 && expectKey) {
        if (/^\s*:/.test(text.slice(i + 1, i + 40))) keys.push(text.slice(start + 1, i))
        expectKey = false
      }
      continue
    }
    if (c === '{' || c === '[' || c === '(') {
      depth++
      if (depth === 1) expectKey = true
      continue
    }
    if (c === '}' || c === ']' || c === ')') {
      depth--
      if (depth === 0) return { open, close: i, keys }
      continue
    }
    if (depth !== 1) continue
    if (c === ',') expectKey = true
    else if (expectKey && /\s/.test(c)) continue
    else if (expectKey) {
      if (text.startsWith('...', i)) i += 2
      else {
        const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 80))
        if (m) {
          keys.push(m[0])
          i += m[0].length - 1
        }
      }
      expectKey = false
    }
  }
  return undefined
}

/**
 * The top-level `key: { ... }` of the config, found only at the config's own indentation, so a comment, a `key: '...'`
 * inside a service, or a nested block of the same name is never mistaken for it. `opaque` is a value that is not an object
 * literal (`secrets: shared`).
 */
function blockAt(text: string, name: string, top: string): Block | 'opaque' | undefined {
  const m = new RegExp(`^${top}${name}\\s*:\\s*`, 'm').exec(text)
  if (!m) return undefined
  const open = m.index + m[0].length
  if (text[open] !== '{') return 'opaque'
  const found = scanObject(text, open)
  if (!found) return 'opaque'
  return { ...found, multiline: /^[ \t]*(\r?\n|\/\/)/.test(text.slice(open + 1)) }
}

const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n')

/** What to do about this spec's credentials in this config text. */
export function planCredentials(
  text: string,
  creds: SpecCredentials,
  loaded: { secrets?: Record<string, unknown>; auth?: Record<string, unknown> } = {},
): CredentialPlan {
  const top = /^([ \t]*)services\s*:/m.exec(text)?.[1] ?? '  '
  const step = top === '' ? '  ' : top.includes('\t') ? '\t' : top.length >= 4 ? top : '  '
  const plan: CredentialPlan = {
    profiles: [],
    add: [],
    reused: [],
    notes: [...creds.notes],
    manual: false,
    top,
    step,
  }
  if (!creds.profiles.length) return plan
  const secrets = blockAt(text, 'secrets', top)
  const auth = blockAt(text, 'auth', top)
  if (secrets === 'opaque' || auth === 'opaque') {
    plan.manual = true
    return plan
  }
  const hasProfiles = new Set([
    ...Object.keys(loaded.auth ?? {}),
    ...(auth && 'keys' in auth ? auth.keys : []),
  ])
  // the service's own profile is its default: when the config has one by that name, the person has set this up already
  const lead = creds.profiles[0] as Profile
  if (hasProfiles.has(lead.name)) {
    plan.notes.unshift(`a profile named "${lead.name}" is already in the config; left as it is`)
    return plan
  }
  // a profile that is a one-line block with entries is rare, and not worth guessing where a comma goes
  if (auth && !auth.multiline && text.slice(auth.open + 1, auth.close).trim() !== '') {
    plan.manual = true
    return plan
  }
  const skipped = creds.profiles.filter((p) => hasProfiles.has(p.name))
  for (const p of skipped)
    plan.notes.push(`a profile named "${p.name}" is already in the config; left as it is`)
  plan.profiles = creds.profiles.filter((p) => !hasProfiles.has(p.name))
  const declared = new Set([
    ...Object.keys(loaded.secrets ?? {}),
    ...(secrets && 'keys' in secrets ? secrets.keys : []),
  ])
  const wanted = [...new Set(plan.profiles.flatMap((p) => p.secrets))]
  for (const name of wanted) (declared.has(name) ? plan.reused : plan.add).push(name)
  return plan
}

/** A JSON-like value as config text; `ind` is where the line it starts on is indented. */
function literal(v: unknown, ind: string, step: string, eol: string): string {
  if (typeof v === 'string') return quote(v)
  if (Array.isArray(v)) return `[${v.map((x) => literal(x, ind, step, eol)).join(', ')}]`
  if (v && typeof v === 'object') {
    const entries = Object.entries(v)
    if (!entries.length) return '{}'
    const inner = entries
      .map(([k, x]) => `${ind}${step}${key(k)}: ${literal(x, `${ind}${step}`, step, eol)},${eol}`)
      .join('')
    return `{${eol}${inner}${ind}}`
  }
  return String(v)
}

/** One profile as config text; `ind` is where its name starts. */
function profileText(p: Profile, ind: string, step: string, eol: string): string {
  const lines = [
    `${ind}${key(p.name)}: {`,
    `${ind}${step}// from the spec's security: ${p.schemes.join(', ')}`,
    `${ind}${step}title: ${quote(p.title)},`,
    `${ind}${step}scheme: ${literal(p.schemes.length === 1 ? p.schemes[0] : p.schemes, '', '', eol)},`,
  ]
  const groups = (['headers', 'query'] as const)
    .map((g) => [g, Object.entries(p.apply[g] ?? {})] as const)
    .filter(([, entries]) => entries.length)
  const only = groups.length === 1 && groups[0]?.[1].length === 1 ? groups[0] : undefined
  if (only) {
    const [g, entries] = only
    const [k, v] = entries[0] as readonly [string, string]
    lines.push(`${ind}${step}apply: { ${g}: { ${key(k)}: ${quote(v)} } },`)
  } else {
    lines.push(`${ind}${step}apply: {`)
    for (const [g, entries] of groups) {
      lines.push(`${ind}${step}${step}${g}: {`)
      for (const [k, v] of entries) lines.push(`${ind}${step}${step}${step}${key(k)}: ${quote(v)},`)
      lines.push(`${ind}${step}${step}},`)
    }
    lines.push(`${ind}${step}},`)
  }
  if (p.oauth) lines.push(`${ind}${step}oauth: ${literal(p.oauth, `${ind}${step}`, step, eol)},`)
  lines.push(`${ind}},`)
  return lines.map((l) => `${l}${eol}`).join('')
}

/** What the service's `auth` is: the one profile's name, or the list with the default first. */
export const authValue = (profiles: Pick<Profile, 'name'>[]): string =>
  profiles.length === 1
    ? quote((profiles[0] as Profile).name)
    : `[${profiles.map((p) => quote(p.name)).join(', ')}]`

const SECRETS_COMMENT =
  '// values come from environment variables of the same name or a gitignored <env>.secrets.env'

const servicesAt = (text: string) => /^[ \t]*services\s*:/m.exec(text)?.index

/** `secrets` with the new names in it: added to the block that is there, or a block of its own before `services`. */
function withSecrets(text: string, plan: CredentialPlan, eol: string): string {
  const { top, step } = plan
  const secrets = blockAt(text, 'secrets', top)
  if (secrets && secrets !== 'opaque') {
    if (secrets.multiline) {
      const at = text.indexOf('\n', secrets.open) + 1
      const lines = plan.add.map((n) => `${top}${step}${n}: {},${eol}`).join('')
      return text.slice(0, at) + lines + text.slice(at)
    }
    const items = plan.add.map((n) => `${n}: {}`).join(', ')
    const empty = text.slice(secrets.open + 1, secrets.close).trim() === ''
    return empty
      ? `${text.slice(0, secrets.open)}{ ${items} }${text.slice(secrets.close + 1)}`
      : `${text.slice(0, secrets.open + 1)} ${items},${text.slice(secrets.open + 1)}`
  }
  const one = `${top}secrets: { ${plan.add.map((n) => `${n}: {}`).join(', ')} },`
  const block =
    one.length <= 100
      ? `${top}${SECRETS_COMMENT}${eol}${one}${eol}`
      : `${top}${SECRETS_COMMENT}${eol}${top}secrets: {${eol}${plan.add.map((n) => `${top}${step}${n}: {},${eol}`).join('')}${top}},${eol}`
  const at = servicesAt(text) as number
  return text.slice(0, at) + block + text.slice(at)
}

/** `auth` with the profiles in it: added to the block that is there, or a block of its own before `services`. */
function withProfile(text: string, plan: CredentialPlan, eol: string): string {
  const { top, step } = plan
  const auth = blockAt(text, 'auth', top)
  const profile = plan.profiles.map((p) => profileText(p, `${top}${step}`, step, eol)).join('')
  if (auth && auth !== 'opaque') {
    if (auth.multiline) {
      const at = text.indexOf('\n', auth.open) + 1
      return text.slice(0, at) + profile + text.slice(at)
    }
    return `${text.slice(0, auth.open + 1)}${eol}${profile}${top}${text.slice(auth.close)}`
  }
  const at = servicesAt(text) as number
  return `${text.slice(0, at)}${top}auth: {${eol}${profile}${top}},${eol}${text.slice(at)}`
}

/**
 * The config text with the plan's secrets and profile in it, or undefined when there is nothing to write or it cannot be
 * edited here. A block that is made is made just before `services`, `secrets` above `auth`.
 */
export function applyCredentials(text: string, plan: CredentialPlan): string | undefined {
  if (!plan.profiles.length || plan.manual || servicesAt(text) === undefined) return undefined
  const eol = eolOf(text)
  const withNames = plan.add.length ? withSecrets(text, plan, eol) : text
  return withProfile(withNames, plan, eol)
}

/** The same credentials as text to paste, for a config that cannot be edited here. */
export function credentialsSnippet(creds: SpecCredentials): string {
  if (!creds.profiles.length) return ''
  const eol = '\n'
  const names = creds.secrets.map((n) => `${n}: {}`).join(', ')
  return [
    `  ${SECRETS_COMMENT}${eol}  secrets: { ${names} },${eol}`,
    `  auth: {${eol}${creds.profiles.map((p) => profileText(p, '    ', '  ', eol)).join('')}  },${eol}`,
    `and \`auth: ${authValue(creds.profiles)},\` in the service`,
  ].join(eol)
}
