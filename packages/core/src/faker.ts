// Locale-aware faker proxy. `@faker-js/faker` is a peer dependency of the user's project;
// the runtime (CLI / UI) installs the concrete instance for the selected locale before a run.

type FakerLike = Record<string, any>

// Held on globalThis so the CLI's bundled copy of core and the project's own import share one instance.
const KEY = '__specbookFaker'
const store = globalThis as unknown as Record<string, FakerLike | undefined>

export const faker: FakerLike = new Proxy({} as FakerLike, {
  get(_t, key) {
    const current = store[KEY]
    if (!current) {
      throw new Error(
        'faker is not initialised. Install "@faker-js/faker" in your project; specbook sets it up before each run.',
      )
    }
    return current[key as string]
  },
})

export function setFaker(instance: FakerLike | undefined): void {
  store[KEY] = instance
}

export interface FakerConfig {
  /** locale name -> fallback chain of faker locale export names, e.g. { de: ['de', 'en', 'base'] } */
  locales?: Record<string, string[]>
  default?: string
}

interface FakerModule {
  Faker: new (opts: { locale: unknown[] }) => FakerLike
  [locale: string]: unknown
}

/** The locale exports a run needs, in fallback order: the chain for `locale`, then `base`. */
export function fakerLocaleNames(config: FakerConfig = {}, locale?: string): string[] {
  const name = locale ?? config.default ?? 'en'
  return [...new Set([...(config.locales?.[name] ?? [name, 'en']), 'base'])]
}

/**
 * The module `installFaker` needs. A bundled build offers each locale as `locales[name]()` so only
 * the ones a run falls back through are fetched; a plain faker module already has them all.
 */
export async function prepareFaker(
  mod: Record<string, any>,
  config: FakerConfig = {},
  locale?: string,
): Promise<FakerModule> {
  const locales = mod.locales as Record<string, () => Promise<unknown>> | undefined
  if (!locales) return mod as FakerModule
  const ready: Record<string, unknown> = { Faker: mod.Faker }
  await Promise.all(
    fakerLocaleNames(config, locale).map(async (n) => {
      const load = locales[n]
      if (load) ready[n] = await load()
    }),
  )
  return ready as FakerModule
}

/** Build a Faker for `locale` from the (dynamically imported) module, install it, and optionally seed it. */
export function installFaker(
  mod: FakerModule,
  config: FakerConfig = {},
  opts: { locale?: string; seed?: number } = {},
): FakerLike {
  const name = opts.locale ?? config.default ?? 'en'
  const locales = fakerLocaleNames(config, name).map((n) => {
    const l = mod[n]
    if (!l) throw new Error(`Unknown faker locale "${n}" (from "${name}")`)
    return l
  })
  const instance = new mod.Faker({ locale: locales })
  if (opts.seed !== undefined) instance.seed(opts.seed)
  setFaker(instance)
  return instance
}
