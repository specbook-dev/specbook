/**
 * What the extension remembers, behind one small interface so it is tested without a browser.
 *
 * - `grants`: per page origin (the "site"), per API origin, what the person allowed. A grant belongs to the
 *   pair: allowing a site to reach an API does not let another site reach it.
 * - `sites`: origins where the person turned the relay on ("Enable").
 */
export interface Area {
  get(keys: string | string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export interface PairState {
  /** may POST, PUT, PATCH and DELETE */
  writes: boolean
  /** may reach a private or loopback address */
  private: boolean
  at: number
}
export type Grants = Record<string, Record<string, PairState>>

const GRANTS = 'grants'
const SITES = 'sites'

export function createState(area: Area, now: () => number = Date.now) {
  // one change at a time: the popup and the worker may both write
  let chain: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }
  const read = async <T>(key: string, empty: T): Promise<T> =>
    ((await area.get(key))[key] as T | undefined) ?? empty

  return {
    grants: () => read<Grants>(GRANTS, {}),
    sites: () => read<string[]>(SITES, []),

    async pair(site: string, api: string): Promise<PairState | undefined> {
      return (await read<Grants>(GRANTS, {}))[site]?.[api]
    },

    allow(site: string, api: string) {
      return exclusive(async () => {
        const g = await read<Grants>(GRANTS, {})
        g[site] = {
          ...g[site],
          [api]: g[site]?.[api] ?? { writes: false, private: false, at: now() },
        }
        await area.set({ [GRANTS]: g })
      })
    },

    setFlag(site: string, api: string, flag: 'writes' | 'private', on: boolean) {
      return exclusive(async () => {
        const g = await read<Grants>(GRANTS, {})
        const p = g[site]?.[api]
        if (!p) return
        g[site] = { ...g[site], [api]: { ...p, [flag]: on } }
        await area.set({ [GRANTS]: g })
      })
    },

    /** Removes the pair. True when no other site still uses this API, so its browser permission can go. */
    revoke(site: string, api: string) {
      return exclusive(async () => {
        const g = await read<Grants>(GRANTS, {})
        if (g[site]) {
          const { [api]: _gone, ...rest } = g[site]
          if (Object.keys(rest).length) g[site] = rest
          else delete g[site]
        }
        await area.set({ [GRANTS]: g })
        return !Object.values(g).some((apis) => api in apis)
      })
    },

    addSite(site: string) {
      return exclusive(async () => {
        const list = await read<string[]>(SITES, [])
        if (!list.includes(site)) await area.set({ [SITES]: [...list, site] })
      })
    },

    removeSite(site: string) {
      return exclusive(async () => {
        const list = await read<string[]>(SITES, [])
        await area.set({ [SITES]: list.filter((s) => s !== site) })
      })
    },
  }
}

export type State = ReturnType<typeof createState>
