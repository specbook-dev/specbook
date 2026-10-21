import { describe, expect, it } from 'vitest'
import { AUDIT_LIMIT, createAudit } from '../src/audit'
import { memoryArea } from './fake'

const event = (i: number) => ({
  at: i,
  site: 'https://ui.specbook.dev',
  origin: 'https://api.example.com',
  method: 'GET',
  path: `/p${i}`,
  outcome: 'ok' as const,
  ms: 1,
})

describe('the audit trail', () => {
  it('keeps the most recent calls, oldest first, up to its limit', async () => {
    const a = createAudit(memoryArea())
    for (let i = 0; i < AUDIT_LIMIT + 25; i++) a.push(event(i))
    const list = await a.list()
    expect(list).toHaveLength(AUDIT_LIMIT)
    expect(list[0]?.path).toBe('/p25')
    expect(list.at(-1)?.path).toBe(`/p${AUDIT_LIMIT + 24}`)
  })
})
