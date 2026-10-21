import type { Area } from '../src/state'

/** A storage area in memory: what `chrome.storage.local` is, for a test. */
export function memoryArea(
  initial: Record<string, unknown> = {},
): Area & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = structuredClone(initial)
  return {
    data,
    async get(keys) {
      const list = typeof keys === 'string' ? [keys] : keys
      return Object.fromEntries(
        list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]),
      )
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v)
    },
  }
}
