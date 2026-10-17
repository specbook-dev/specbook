import type { Order, Pet } from '#api/petstore'

/** What a visitor can switch on to see the runner handle trouble. Off by default. */
export interface Chaos {
  /** every request to a demo API answers 500 */
  fail: boolean
  /** the next this many requests answer 500, then it is fine again: a flaky service */
  failNext: number
  /** wait this long before answering */
  latencyMs: number
  /** answer with changed data (a delivered order, a sold pet), which a check on the old data catches */
  mutate: boolean
  /** a pet or an order that exists answers 404 */
  notFound: boolean
}

export const calm = (): Chaos => ({
  fail: false,
  failNext: 0,
  latencyMs: 0,
  mutate: false,
  notFound: false,
})

export interface DemoState {
  pets: Pet[]
  orders: Order[]
  nextOrderId: number
  chaos: Chaos
}

/** Where the demo's data is kept between requests. The service worker uses IndexedDB, node and tests use memory. */
export interface Store {
  /** the saved state, or nothing yet */
  read(): Promise<DemoState | undefined>
  write(state: DemoState): Promise<void>
  clear(): Promise<void>
}

export function memoryStore(): Store {
  let saved: string | undefined
  return {
    read: async () => (saved ? (JSON.parse(saved) as DemoState) : undefined),
    write: async (state) => {
      saved = JSON.stringify(state)
    },
    clear: async () => {
      saved = undefined
    },
  }
}
