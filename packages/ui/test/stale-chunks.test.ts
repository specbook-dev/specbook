import { describe, expect, it } from 'vitest'
import { reloadForStaleChunk } from '../src/stale-chunks'

const env = (last: number, now: number) => {
  const state = { last, reloads: 0 }
  return {
    state,
    env: {
      now: () => now,
      last: () => state.last,
      remember: (t: number) => (state.last = t),
      reload: () => state.reloads++,
    },
  }
}

describe('a chunk that a new deploy removed', () => {
  it('loads the new page', () => {
    const { env: e, state } = env(0, 1_000_000)
    expect(reloadForStaleChunk(e)).toBe(true)
    expect(state.reloads).toBe(1)
  })

  it('does not reload again within a minute, so a real outage is not a loop', () => {
    const { env: e, state } = env(1_000_000 - 30_000, 1_000_000)
    expect(reloadForStaleChunk(e)).toBe(false)
    expect(state.reloads).toBe(0)
  })

  it('reloads again after a minute', () => {
    const { env: e, state } = env(1_000_000 - 61_000, 1_000_000)
    expect(reloadForStaleChunk(e)).toBe(true)
    expect(state.reloads).toBe(1)
  })
})
