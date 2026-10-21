import type { WireAuditEvent, WireHost } from '@specbook/core/wire'
import type { State } from './state'

export interface HostDeps {
  state: State
  /** Does the browser itself hold access to this API origin (the optional host permission)? */
  hasPermission(apiOrigin: string): Promise<boolean>
  /** Put these origins in front of the person; they answer in the extension's own window. */
  openGrant(site: string, origins: string[], opts?: { writes?: boolean }): void | Promise<void>
  /** Is the relay on for this site? */
  siteEnabled?(site: string): boolean | Promise<boolean>
  audit?: { push(e: WireAuditEvent): void }
  fetch?: typeof fetch
}

/**
 * The extension's answers to the dispatcher's questions. A pair is granted only when the person allowed it
 * here **and** the browser still holds the host permission, so revoking the permission in the browser's own
 * extension page closes it even if this store was not told.
 */
export function createHost(d: HostDeps): WireHost {
  return {
    async isGranted(site, api) {
      if (!(await d.state.pair(site, api))) return false
      return d.hasPermission(api)
    },
    async allowsWrites(site, api) {
      return (await d.state.pair(site, api))?.writes ?? false
    },
    async allowsPrivate(site, api) {
      return (await d.state.pair(site, api))?.private ?? false
    },
    requestGrant: (site, origins, opts) => d.openGrant(site, origins, opts),
    pageEnabled: (site) => d.siteEnabled?.(site) ?? true,
    record: (e) => d.audit?.push(e),
    fetch: d.fetch,
  }
}
