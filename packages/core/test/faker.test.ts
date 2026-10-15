import { describe, expect, it } from 'vitest'
import { faker, fakerLocaleNames, installFaker, prepareFaker, setFaker } from '../src'

class FakeFaker {
  seeded?: number
  constructor(readonly opts: { locale: unknown[] }) {}
  seed(n: number) {
    this.seeded = n
  }
  get who() {
    return this.opts.locale.map((l: any) => l.name).join('>')
  }
}
const mod = { Faker: FakeFaker, en: { name: 'en' }, de: { name: 'de' }, base: { name: 'base' } }

describe('faker proxy', () => {
  it('throws a helpful error before it is installed', () => {
    setFaker(undefined)
    expect(() => faker.who).toThrow(/not initialised/)
  })
  it('installs a locale fallback chain (always ending in base) and seeds', () => {
    installFaker(
      mod as any,
      { locales: { de: ['de', 'en'] }, default: 'en' },
      { locale: 'de', seed: 7 },
    )
    expect(faker.who).toBe('de>en>base')
    expect((faker as any).seeded).toBe(7)
  })
  it('fails clearly on an unknown locale', () => {
    expect(() => installFaker(mod as any, {}, { locale: 'xx' })).toThrow(
      /Unknown faker locale "xx"/,
    )
  })
})

describe('locale loading', () => {
  it('names the locales a run falls back through, ending in base', () => {
    expect(fakerLocaleNames({}, 'en')).toEqual(['en', 'base'])
    expect(fakerLocaleNames({ locales: { de: ['de', 'en'] } }, 'de')).toEqual(['de', 'en', 'base'])
    expect(fakerLocaleNames({ default: 'de' })).toEqual(['de', 'en', 'base'])
  })

  it('fetches only those locales from a bundled module', async () => {
    const loaded: string[] = []
    const load = (name: string) => async () => {
      loaded.push(name)
      return { name }
    }
    const bundled = {
      Faker: FakeFaker,
      locales: { en: load('en'), de: load('de'), ja: load('ja'), base: load('base') },
    }
    const ready = await prepareFaker(bundled, { locales: { de: ['de', 'en'] } }, 'de')
    expect(loaded.sort()).toEqual(['base', 'de', 'en'])
    expect(Object.keys(ready).sort()).toEqual(['Faker', 'base', 'de', 'en'])
    expect(installFaker(ready, { locales: { de: ['de', 'en'] } }, { locale: 'de' }).who).toBe(
      'de>en>base',
    )
  })

  it('passes a plain faker module through', async () => {
    expect(await prepareFaker(mod)).toBe(mod)
  })
})
