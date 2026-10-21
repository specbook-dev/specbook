import { describe, expect, it } from 'vitest'
import { unreadableWhy } from '../src/viewer/share'

describe('unreadableWhy', () => {
  it('says "local" for a file address and for the visitor’s own machine or network', () => {
    for (const a of [
      'file:///Users/me/openapi.json',
      'http://localhost:8080/openapi.json',
      'http://127.0.0.1/openapi.json',
      'http://192.168.1.20:3000/openapi.json',
      'https://api.internal/openapi.json',
      'http://[::1]:3000/openapi.json',
    ])
      expect(unreadableWhy(a), a).toBe('local')
  })

  it('says "cors" for any other address, which is a server that keeps browsers out', () => {
    for (const a of [
      'https://example.com/openapi.json',
      'http://203.0.113.5/spec',
      'not an address',
    ])
      expect(unreadableWhy(a), a).toBe('cors')
  })
})
