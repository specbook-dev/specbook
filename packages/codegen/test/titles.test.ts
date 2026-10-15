import { describe, expect, it } from 'vitest'
import { generateData } from '../src/browser'
import { titleOf } from '../src/build'

describe('titleOf', () => {
  it('prefers the summary', () => {
    expect(titleOf({ summary: 'List pets', description: 'Returns every pet in the store.' })).toBe(
      'List pets',
    )
  })

  it('falls back to the description when the summary is missing or blank', () => {
    expect(titleOf({ description: 'Returns every pet.' })).toBe('Returns every pet.')
    expect(titleOf({ summary: '', description: 'Returns every pet.' })).toBe('Returns every pet.')
    expect(titleOf({ summary: '   ', description: 'Returns every pet.' })).toBe(
      'Returns every pet.',
    )
  })

  it('takes the first line of a longer description, with its HTML removed', () => {
    expect(titleOf({ description: '<p>List apple pay <b>domains</b>.</p>' })).toBe(
      'List apple pay domains .',
    )
    expect(titleOf({ description: 'First line.\n\nMore detail follows here.' })).toBe('First line.')
    expect(titleOf({ description: '<p>Fish &amp; chips &lt;3</p>' })).toBe('Fish & chips <3')
  })

  it('gives nothing when there is nothing to show', () => {
    expect(titleOf({})).toBeUndefined()
    expect(titleOf({ summary: '', description: '' })).toBeUndefined()
    expect(titleOf({ summary: '', description: '<p></p>' })).toBeUndefined()
  })

  it('keeps a very long first line to a title', () => {
    const t = titleOf({ description: `${'word '.repeat(60)}end` }) ?? ''
    expect(t.length).toBeLessThanOrEqual(121)
    expect(t.endsWith('…')).toBe(true)
  })
})

describe('operation titles in generated metadata', () => {
  it('never produces an empty summary, whatever the spec leaves out', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 'T', version: '1' },
      paths: {
        '/a': {
          post: {
            operationId: 'blank',
            summary: '',
            description: '',
            responses: { '200': { description: 'ok' } },
          },
        },
        '/b': {
          get: {
            operationId: 'html',
            description: '<p>Retrieve a thing.</p>',
            responses: { '200': { description: 'ok' } },
          },
        },
        '/c': {
          get: {
            operationId: 'plain',
            summary: 'Plain title',
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    }
    const { operations } = generateData(doc as never, { service: 'svc' })
    const byPath = (path: string) => operations.find((o) => o.path === path)
    expect(operations).toHaveLength(3)
    expect(byPath('/a')?.summary).toBeUndefined()
    expect(byPath('/b')?.summary).toBe('Retrieve a thing.')
    expect(byPath('/c')?.summary).toBe('Plain title')
  })
})
