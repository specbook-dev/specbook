/**
 * Environments a person makes in the browser, for pages with no project files to write them to (a built
 * site, the hosted viewer). A variable here is not a secret, so it lives in `localStorage`, kept per spec; a
 * document opened from a file has no stable address and keeps them for the tab only.
 */
import { kv } from './storage'

const KEY = 'specbook.environments.v1'

export interface BrowserEnvironment {
  /** the environment it was copied from; absent for a built-in environment this browser overrides */
  from?: string
  vars: Record<string, string>
}

export interface EnvironmentStore {
  all(): Record<string, BrowserEnvironment>
  save(name: string, env: BrowserEnvironment): void
  remove(name: string): void
}

type Table = Record<string, Record<string, BrowserEnvironment>>

const memory: Record<'local' | 'session', Table> = { local: {}, session: {} }

const storageOf = (kind: 'local' | 'session') => (kind === 'local' ? kv.local : kv.session)

function read(kind: 'local' | 'session'): Table {
  try {
    const raw = storageOf(kind).getItem(KEY)
    return raw ? (JSON.parse(raw) as Table) : memory[kind]
  } catch {
    return memory[kind]
  }
}

function write(kind: 'local' | 'session', table: Table) {
  memory[kind] = table
  try {
    storageOf(kind).setItem(KEY, JSON.stringify(table))
  } catch {
    /* private mode or blocked storage: the in-memory copy still serves this page */
  }
}

/** The store for one spec (`scope`: its address); `session` keeps it for this tab only. */
export function createEnvironmentStore(
  scope: string,
  kind: 'local' | 'session' = 'local',
): EnvironmentStore {
  return {
    all: () => read(kind)[scope] ?? {},
    save(name, env) {
      const t = read(kind)
      write(kind, { ...t, [scope]: { ...t[scope], [name]: env } })
    },
    remove(name) {
      const t = read(kind)
      const { [name]: _gone, ...rest } = t[scope] ?? {}
      write(kind, { ...t, [scope]: rest })
    },
  }
}
