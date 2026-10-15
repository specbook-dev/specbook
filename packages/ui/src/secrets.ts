/**
 * Where a static page keeps the credentials a person types in.
 *
 * Values are keyed by (API origin, secret name): a key typed for one API is never sent to another
 * host, whatever a spec's `servers` says. The backend is `sessionStorage` (this tab only, gone when it
 * closes) with an in-memory fallback; another backend (an encrypted store, say) can sit behind the same
 * interface. Requests carry `{{secrets.NAME}}` placeholders until the transport sends them.
 */
const KEY = 'specbook.secrets.v1'

type Table = Record<string, Record<string, string>>

export interface SecretStore {
  get(origin: string, name: string): string | undefined
  set(origin: string, name: string, value: string): void
  remove(origin: string, name: string): void
}

let memory: Table = {}

const read = (): Table => {
  try {
    const raw = sessionStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Table) : memory
  } catch {
    return memory
  }
}

const write = (t: Table) => {
  memory = t
  try {
    sessionStorage.setItem(KEY, JSON.stringify(t))
  } catch {
    /* private mode or blocked storage: the in-memory copy still serves this page */
  }
}

export const secretStore: SecretStore = {
  get: (origin, name) => read()[origin]?.[name],
  set(origin, name, value) {
    const t = read()
    write({ ...t, [origin]: { ...t[origin], [name]: value } })
  },
  remove(origin, name) {
    const t = read()
    const { [name]: _gone, ...rest } = t[origin] ?? {}
    write({ ...t, [origin]: rest })
  },
}

export const originOf = (url: string | undefined): string | undefined => {
  try {
    return url ? new URL(url).origin : undefined
  } catch {
    return undefined
  }
}

/** `{{secrets.NAME}}`, the same placeholder the dev server's proxy substitutes. */
export const SECRET_PLACEHOLDER = /\{\{\s*secrets\.([\w$-]+)\s*\}\}/g
