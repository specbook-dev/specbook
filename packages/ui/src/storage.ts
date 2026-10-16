// Where the UI keeps what a person typed. In the app and the viewer it is the browser's storage, kept as before. In an embed
// it is memory: a docs page shares its origin's `localStorage` with its own code, and a visitor's drafts and credentials
// must not land there, or be read from there.

export type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function memory(): Store {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  }
}

/** Reading the global can itself throw (blocked site data), so it is done when asked and a failure falls back to memory. */
function browser(which: 'localStorage' | 'sessionStorage'): Store {
  try {
    const s = globalThis[which]
    if (s) return s
  } catch {
    /* blocked */
  }
  return memory()
}

let local: Store | undefined
let session: Store | undefined
let isolated = false

export const kv = {
  get local(): Store {
    if (!isolated) return browser('localStorage')
    if (!local) local = memory()
    return local
  },
  get session(): Store {
    if (!isolated) return browser('sessionStorage')
    if (!session) session = memory()
    return session
  },
}

/** From here on nothing is read from or written to the page's own storage. */
export function useMemoryStorage(): void {
  isolated = true
  local = undefined
  session = undefined
}

/** Back to the browser's storage (for tests). */
export function useBrowserStorage(): void {
  isolated = false
  local = undefined
  session = undefined
}

export const storageIsolated = () => isolated
