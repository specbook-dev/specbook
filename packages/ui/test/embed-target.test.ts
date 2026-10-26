import { describe, expect, it } from 'vitest'
import { parseTarget } from '../src/embed/target'
import { pageScheme, schemeFor } from '../src/embed/theme'

/** The few parts of an element the parser reads, without a DOM. */
function el(attrs: Record<string, string | true>, ancestors: Record<string, string | true>[] = []) {
  const read = (a: Record<string, string | true>, name: string) =>
    name in a ? (a[name] === true ? '' : (a[name] as string)) : null
  const node = (a: Record<string, string | true>, up: Record<string, string | true>[]): never =>
    ({
      getAttribute: (n: string) => read(a, n),
      hasAttribute: (n: string) => n in a,
      closest: (sel: string) => {
        const name = /\[([^\]]+)\]/.exec(sel)?.[1] as string
        if (name in a) return node(a, up)
        const hit = up.find((x) => name in x)
        return hit ? node(hit, []) : null
      },
    }) as never
  return node(attrs, ancestors)
}

describe('parseTarget', () => {
  it('reads a request by service and operation, or by operation alone', () => {
    expect(parseTarget(el({ 'data-specbook-try': 'petstore/GetPetById' }))).toMatchObject({
      service: 'petstore',
      operation: 'GetPetById',
      autoRun: false,
    })
    const bare = parseTarget(el({ 'data-specbook-try': 'GetPetById' }))
    expect(bare?.operation).toBe('GetPetById')
    expect(bare?.service).toBeUndefined()
  })

  it('reads a script by its id; a flow wins over it and it wins over a request', () => {
    expect(parseTarget(el({ 'data-specbook-script': 'turnstile' }))?.script).toBe('turnstile')
    const both = parseTarget(el({ 'data-specbook-script': 's', 'data-specbook-flow': 'f' }))
    expect([both?.sequence, both?.script]).toEqual(['f', undefined])
    const withTry = parseTarget(el({ 'data-specbook-script': 's', 'data-specbook-try': 'a/B' }))
    expect([withTry?.script, withTry?.operation]).toEqual(['s', undefined])
  })

  it('reads a saved request by its file, and a flow by its id', () => {
    const saved = parseTarget(el({ 'data-specbook-try': 'requests/petstore/find-pets.req.ts' }))
    expect(saved?.request).toBe('requests/petstore/find-pets.req.ts')
    expect(saved?.operation).toBeUndefined()
    expect(parseTarget(el({ 'data-specbook-flow': 'adopt-pet' }))?.sequence).toBe('adopt-pet')
  })

  it('is nothing for an element that names neither, and the old attributes are not read', () => {
    expect(parseTarget(el({}))).toBeUndefined()
    expect(
      parseTarget(el({ 'data-specbook': 'petstore', 'data-operation': 'GetPetById' })),
    ).toBeUndefined()
  })

  it('takes example, tab, environment, theme and auto-run, and the page-wide defaults', () => {
    const t = parseTarget(
      el(
        {
          'data-specbook-flow': 'adopt-pet',
          'data-specbook-example': 'rex',
          'data-specbook-tab': 'docs',
          'data-specbook-auto-run': true,
        },
        [{ 'data-specbook-env': 'demo' }, { 'data-specbook-theme': 'dark' }],
      ),
    )
    expect(t).toMatchObject({
      example: 'rex',
      tab: 'docs',
      env: 'demo',
      theme: 'dark',
      autoRun: true,
    })
    // an element's own value beats the page's
    expect(
      parseTarget(
        el({ 'data-specbook-try': 'GetPetById', 'data-specbook-env': 'mock' }, [
          { 'data-specbook-env': 'demo' },
        ]),
      )?.env,
    ).toBe('mock')
    expect(
      parseTarget(el({ 'data-specbook-try': 'GetPetById', 'data-specbook-theme': 'neon' }))?.theme,
    ).toBeUndefined()
  })

  it('merges JSON inputs, and reports a bad value instead of throwing', () => {
    expect(
      parseTarget(el({ 'data-specbook-flow': 'f', 'data-specbook-inputs': '{"quantity":2}' }))
        ?.inputs,
    ).toEqual({ quantity: 2 })
    const bad = parseTarget(el({ 'data-specbook-flow': 'f', 'data-specbook-inputs': '{nope' }))
    expect(bad?.inputs).toBeUndefined()
    expect(bad?.problem).toContain('not valid JSON')
    expect(
      parseTarget(el({ 'data-specbook-flow': 'f', 'data-specbook-inputs': '[1]' }))?.problem,
    ).toContain('JSON object')
  })
})

describe('the theme of the page', () => {
  it('reads data-theme, then classes, then color-scheme, else follows the system', () => {
    expect(pageScheme({ attr: 'dark', classes: 'light' })).toBe('dark')
    expect(pageScheme({ classes: 'docs dark' })).toBe('dark')
    expect(pageScheme({ classes: 'light' })).toBe('light')
    expect(pageScheme({ colorScheme: 'dark' })).toBe('dark')
    expect(pageScheme({ colorScheme: 'light dark' })).toBeUndefined()
    expect(pageScheme({})).toBeUndefined()
  })

  it('lets an element choose: light and dark are fixed, auto follows the system, host follows the page', () => {
    expect(schemeFor('light', { attr: 'dark' })).toBe('light')
    expect(schemeFor('auto', { attr: 'dark' })).toBeUndefined()
    expect(schemeFor('host', { attr: 'dark' })).toBe('dark')
    expect(schemeFor(undefined, { attr: 'light' })).toBe('light')
  })
})
