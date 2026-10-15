/**
 * Pasted and dropped documents, kept in this browser so a reload reopens them. They are never shared
 * (a link cannot carry them) and only the last few are kept.
 */
const DB = 'specbook-viewer'
const STORE = 'uploads'
const KEEP = 5

interface Row {
  id: string
  name: string
  text: string
  at: number
}

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' })
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

const done = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

export async function saveUpload(name: string, text: string): Promise<string | undefined> {
  try {
    const d = await db()
    const id = Math.random().toString(36).slice(2, 10)
    const s = d.transaction(STORE, 'readwrite').objectStore(STORE)
    await done(s.put({ id, name, text, at: Date.now() } satisfies Row))
    const all = (await done(s.getAll())) as Row[]
    for (const old of all.sort((a, b) => b.at - a.at).slice(KEEP)) s.delete(old.id)
    return id
  } catch {
    return undefined
  }
}

export async function loadUpload(id: string): Promise<{ name: string; text: string } | undefined> {
  try {
    const d = await db()
    const row = (await done(d.transaction(STORE).objectStore(STORE).get(id))) as Row | undefined
    return row ? { name: row.name, text: row.text } : undefined
  } catch {
    return undefined
  }
}
