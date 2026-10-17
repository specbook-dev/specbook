import type { DemoState, Store } from './store'

const STORE = 'kv'
const KEY = 'state'

const open = (name: string) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

const wrap = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

/**
 * The demo's data in the browser's IndexedDB, because a browser stops a service worker whenever it likes and takes its
 * memory with it. One record holds all of it. If IndexedDB is unavailable the state lasts as long as the worker does.
 */
export function idbStore(name = 'specbook-demo'): Store {
  let db: Promise<IDBDatabase> | undefined
  let memory: DemoState | undefined
  let broken = false
  const use = async <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>) => {
    db ??= open(name)
    const handle = await db
    return wrap(run(handle.transaction(STORE, mode).objectStore(STORE)))
  }
  return {
    read: async () => {
      if (broken) return memory
      try {
        return (await use('readonly', (s) => s.get(KEY))) as DemoState | undefined
      } catch {
        broken = true
        return memory
      }
    },
    write: async (state) => {
      memory = state
      if (broken) return
      try {
        await use('readwrite', (s) => s.put(state, KEY))
      } catch {
        broken = true
      }
    },
    clear: async () => {
      memory = undefined
      if (broken) return
      try {
        await use('readwrite', (s) => s.delete(KEY))
      } catch {
        broken = true
      }
    },
  }
}
