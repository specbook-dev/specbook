import { environments } from '../store'

/**
 * In the viewer a document opens on mock data. Say so, and where the real API is, once, on the stage:
 * someone who has pasted a link and sees a response should not wonder whether it came from the server.
 */
export function ModeHint() {
  if (!globalThis.__SPECBOOK_VIEWER__) return null
  const live = environments.value.some((e) => e !== 'mock')
  return (
    <p class="muted overview-mode">
      {live
        ? 'Requests start on mock data. Switch Environment to live to call the real API.'
        : 'Requests run on generated mock data: this document does not say where the API lives.'}
    </p>
  )
}
