import type { WireAuditEvent } from '@specbook/core/wire'
import type { Area } from './state'

const KEY = 'audit'
export const AUDIT_LIMIT = 200

/**
 * The last calls made for pages: who asked, which API, which method and path (never a query string, a header
 * or a body). Kept in session storage, so it is gone when the browser closes.
 */
export function createAudit(area: Area) {
  let chain: Promise<unknown> = Promise.resolve()
  return {
    push(e: WireAuditEvent) {
      chain = chain
        .then(async () => {
          const list = ((await area.get(KEY))[KEY] as WireAuditEvent[] | undefined) ?? []
          await area.set({ [KEY]: [...list, e].slice(-AUDIT_LIMIT) })
        })
        .catch(() => undefined)
    },
    async list(): Promise<WireAuditEvent[]> {
      await chain
      return ((await area.get(KEY))[KEY] as WireAuditEvent[] | undefined) ?? []
    },
  }
}
export type Audit = ReturnType<typeof createAudit>
