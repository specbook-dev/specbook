// Secret resolution (OSS): env vars > --secrets-file > .specbook/secrets.local.env.
// Other sources (a cloud secret manager, a vault) plug in through `SecretProvider`.

export interface SecretRef {
  /** Environment variable name; defaults to the secret's own name. */
  env?: string
}

export interface SecretProvider {
  name: string
  resolve(ref: SecretRef, name: string): Promise<string | undefined> | string | undefined
}

export class MissingSecretsError extends Error {
  constructor(readonly names: string[]) {
    super(`Missing secrets: ${names.join(', ')}`)
    this.name = 'MissingSecretsError'
  }
}

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '')
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

export function envProvider(env: Record<string, string | undefined>): SecretProvider {
  return { name: 'env', resolve: (ref, name) => env[ref.env ?? name] }
}

export function dotenvProvider(values: Record<string, string>, name = 'dotenv'): SecretProvider {
  return { name, resolve: (ref, n) => values[ref.env ?? n] }
}

/** Providers are tried in order; the first defined value wins. */
export async function resolveSecrets(
  names: Iterable<string>,
  refs: Record<string, SecretRef>,
  providers: SecretProvider[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const missing: string[] = []
  for (const name of names) {
    let value: string | undefined
    for (const p of providers) {
      value = await p.resolve(refs[name] ?? {}, name)
      if (value !== undefined) break
    }
    if (value === undefined) missing.push(name)
    else out[name] = value
  }
  if (missing.length) throw new MissingSecretsError(missing)
  return out
}

/** Secrets shorter than this are not masked: they would blank out ordinary text. */
const MIN_MASKED = 3

/**
 * A secret as it can appear in a URL, a JSON string or a Basic-auth style base64 value, besides itself: what a server
 * echoes back or an error message quotes is not always the raw value.
 */
export function maskVariants(secret: string): string[] {
  const out = new Set<string>([secret])
  const add = (f: () => string) => {
    try {
      out.add(f())
    } catch {
      /* not encodable: the raw value is still masked */
    }
  }
  add(() => encodeURIComponent(secret))
  add(() => encodeURI(secret))
  add(() => JSON.stringify(secret).slice(1, -1))
  add(() => btoa(String.fromCharCode(...new TextEncoder().encode(secret))))
  return [...out]
}

/**
 * Masks with `***`, longest first so a secret containing another is hidden whole. Every secret is masked in its
 * raw, URL-encoded, JSON-escaped and base64 forms; values under 3 characters are skipped to avoid masking
 * ordinary text.
 */
export function maskDeep<T>(value: T, secrets: Iterable<string>): T {
  const list = [
    ...new Set([...secrets].filter((s) => s.length >= MIN_MASKED).flatMap(maskVariants)),
  ].sort((a, b) => b.length - a.length)
  if (list.length === 0) return value
  const maskStr = (s: string) => list.reduce((acc, v) => acc.split(v).join('***'), s)
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return maskStr(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [maskStr(k), walk(x)]))
    }
    return v
  }
  return walk(value) as T
}
