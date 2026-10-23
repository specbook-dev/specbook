import { describe, expect, it } from 'vitest'
import { bundleJson, sortFiles } from '../src/viewer/bundles'

const docs = (id: string, body: unknown) => ({
  path: `docs/${id}.json`,
  content: JSON.stringify(body),
})

describe('which docs files the viewer keeps', () => {
  const kept = (body: unknown) =>
    JSON.parse(bundleJson(sortFiles([docs('Op', body)]).ops.get('Op'))).docs

  it('keeps one that only says what the responses are', () => {
    const responses = { '404': { description: 'No such pet' } }
    expect(kept({ examples: [], responses })).toEqual({ examples: [], responses })
  })

  it('drops one with no text, no response notes and no examples beyond the generated pair', () => {
    expect(kept({ examples: [{ name: 'a' }, { name: 'b' }] })).toBeUndefined()
  })

  it('keeps one with a description', () => {
    expect(kept({ description: 'Looks a pet up.', examples: [] })).toBeDefined()
  })
})
