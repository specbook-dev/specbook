import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDotenv } from '@specbook/core/internal'

/**
 * Per-environment values live in `.specbook/environments/`:
 *   staging.env          non-secret variables, committed
 *   staging.secrets.env  secrets, gitignored by the folder's own .gitignore
 * `.specbook/secrets.local.env` stays as the shared, all-environments fallback for secrets.
 */
export const ENV_NAME = /^[A-Za-z0-9_-]+$/
const VAR_NAME = /^[A-Za-z_][\w.-]*$/

export const environmentsDir = (root: string) => join(root, '.specbook', 'environments')
export const varsFile = (root: string, env: string) => join(environmentsDir(root), `${env}.env`)
export const secretsFileFor = (root: string, env: string) =>
  join(environmentsDir(root), `${env}.secrets.env`)
export const sharedSecretsFile = (root: string) => join(root, '.specbook', 'secrets.local.env')

export const isEnvName = (s: unknown): s is string => typeof s === 'string' && ENV_NAME.test(s)
export const isVarName = (s: unknown): s is string => typeof s === 'string' && VAR_NAME.test(s)

async function readParsed(file: string): Promise<Record<string, string>> {
  return existsSync(file) ? parseDotenv(await readFile(file, 'utf8')) : {}
}

export interface EnvironmentValues {
  /** non-secret variables from `<env>.env` */
  vars: Record<string, string>
  /** secrets from `<env>.secrets.env` */
  secrets: Record<string, string>
  /** secrets shared by every environment (`secrets.local.env`) */
  shared: Record<string, string>
}

export async function readEnvironment(root: string, env: string): Promise<EnvironmentValues> {
  if (!isEnvName(env))
    return { vars: {}, secrets: {}, shared: await readParsed(sharedSecretsFile(root)) }
  const [vars, secrets, shared] = await Promise.all([
    readParsed(varsFile(root, env)),
    readParsed(secretsFileFor(root, env)),
    readParsed(sharedSecretsFile(root)),
  ])
  return { vars, secrets, shared }
}

/** Names of environments that have a file, from `<name>.env` and `<name>.secrets.env`. */
export async function listEnvironmentFiles(root: string): Promise<string[]> {
  const dir = environmentsDir(root)
  if (!existsSync(dir)) return []
  const names = new Set<string>()
  for (const f of await readdir(dir)) {
    const m = /^([A-Za-z0-9_-]+)(\.secrets)?\.env$/.exec(f)
    if (m) names.add(m[1] as string)
  }
  return [...names].sort()
}

/** The committed variable files, for the registry and static builds. */
export async function readAllVars(root: string): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {}
  const dir = environmentsDir(root)
  if (!existsSync(dir)) return out
  for (const f of await readdir(dir)) {
    const m = /^([A-Za-z0-9_-]+)\.env$/.exec(f)
    if (m) out[m[1] as string] = parseDotenv(await readFile(join(dir, f), 'utf8'))
  }
  return out
}

const quote = (v: string) => {
  if (/[\r\n]/.test(v)) throw new Error('values must be a single line')
  if (!/[\s#"'\\]/.test(v)) return v
  if (!v.includes('"')) return `"${v}"`
  if (!v.includes("'")) return `'${v}'`
  return v
}

/** Insert, replace or (with `undefined`) delete one key, leaving every other line untouched. */
export function setDotenvKey(text: string, key: string, value: string | undefined): string {
  const lines = text === '' ? [] : text.split('\n')
  const at = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?${escapeRe(key)}\\s*=`).test(l))
  if (value === undefined) {
    if (at >= 0) lines.splice(at, 1)
  } else if (at >= 0) lines[at] = `${key}=${quote(value)}`
  else {
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    lines.push(`${key}=${quote(value)}`)
  }
  const out = lines.join('\n')
  return out === '' || out.endsWith('\n') ? out : `${out}\n`
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Creates `environments/` with its own .gitignore, so secrets files can never be committed by accident. */
export async function ensureEnvironmentsDir(root: string): Promise<string> {
  const dir = environmentsDir(root)
  await mkdir(dir, { recursive: true })
  const ignore = join(dir, '.gitignore')
  if (!existsSync(ignore))
    await writeFile(ignore, '# secrets never leave this machine\n*.secrets.env\n')
  return dir
}

export async function writeEnvKey(
  file: string,
  key: string,
  value: string | undefined,
): Promise<void> {
  const current = existsSync(file) ? await readFile(file, 'utf8') : ''
  await writeFile(file, setDotenvKey(current, key, value))
}
