import { afterEach, describe, expect, it } from 'vitest'
import { kv, storageIsolated, useBrowserStorage, useMemoryStorage } from '../src/storage'

describe('storage', () => {
  afterEach(() => useBrowserStorage())

  it('keeps what a person typed in memory once an embed asks, and never in the page storage', () => {
    const page = new Map<string, string>()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => page.get(k) ?? null,
      setItem: (k: string, v: string) => void page.set(k, v),
      removeItem: (k: string) => void page.delete(k),
    }
    kv.local.setItem('a', '1')
    expect(page.get('a')).toBe('1')
    useMemoryStorage()
    expect(storageIsolated()).toBe(true)
    kv.local.setItem('b', '2')
    expect(kv.local.getItem('b')).toBe('2')
    expect(page.has('b')).toBe(false)
    expect(kv.local.getItem('a')).toBeNull()
    kv.local.removeItem('b')
    expect(kv.local.getItem('b')).toBeNull()
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it('falls back to memory when the browser has none', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage
    kv.local.setItem('x', 'y')
    expect(typeof kv.local.getItem).toBe('function')
  })
})
