import { describe, expect, it } from 'vitest'
import { createState } from '../src/state'
import { memoryArea } from './fake'

const A = 'https://ui.specbook.dev'
const B = 'https://docs.acme.com'
const API = 'https://api.example.com'
const OTHER = 'https://other.example'

describe('grants belong to a pair of site and API', () => {
  it('start read-only, public-only, and are the pair’s own', async () => {
    const s = createState(memoryArea(), () => 1234)
    await s.allow(A, API)
    expect(await s.pair(A, API)).toEqual({ writes: false, private: false, at: 1234 })
    expect(await s.pair(B, API)).toBeUndefined()
    expect(await s.pair(A, OTHER)).toBeUndefined()
  })

  it('allowing again keeps what the person already set', async () => {
    const s = createState(memoryArea())
    await s.allow(A, API)
    await s.setFlag(A, API, 'writes', true)
    await s.allow(A, API)
    expect((await s.pair(A, API))?.writes).toBe(true)
  })

  it('sets a flag only for a pair that exists, and only that one', async () => {
    const s = createState(memoryArea())
    await s.setFlag(A, API, 'writes', true)
    expect(await s.pair(A, API)).toBeUndefined()
    await s.allow(A, API)
    await s.allow(B, API)
    await s.setFlag(A, API, 'private', true)
    expect((await s.pair(A, API))?.private).toBe(true)
    expect((await s.pair(B, API))?.private).toBe(false)
  })

  it('says whether anyone else still uses an API once a pair is revoked', async () => {
    const s = createState(memoryArea())
    await s.allow(A, API)
    await s.allow(B, API)
    expect(await s.revoke(A, API)).toBe(false)
    expect(await s.pair(A, API)).toBeUndefined()
    expect(await s.pair(B, API)).toBeDefined()
    expect(await s.revoke(B, API)).toBe(true)
    expect(await s.grants()).toEqual({})
  })

  it('does not lose a change when several arrive at once', async () => {
    const s = createState(memoryArea())
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.allow(A, `https://api${i}.example`)))
    expect(Object.keys((await s.grants())[A] ?? {})).toHaveLength(20)
  })
})

describe('sites where the person turned the relay on', () => {
  it('are a list without repeats', async () => {
    const s = createState(memoryArea())
    await s.addSite(B)
    await s.addSite(B)
    expect(await s.sites()).toEqual([B])
    await s.removeSite(B)
    expect(await s.sites()).toEqual([])
  })
})
