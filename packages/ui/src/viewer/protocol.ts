import type { AuthProfileLike } from './registry-data'

/** Where a spec comes from. */
export type Source = { kind: 'url'; url: string } | { kind: 'text'; text: string; name?: string }

export interface Timings {
  /** fetching the document (url sources) */
  fetch?: number
  parse: number
  generate: number
  total: number
}

export interface OpenResult {
  /** slug of the API title: the service key the UI uses */
  service: string
  title: string
  /** the manifest's operation list, as the UI's registry wants it */
  manifest: Record<string, unknown>
  /** per operation, what `defineOperation` needs */
  metas: Record<string, Record<string, unknown>>
  /** operation id -> the example names offered (spec ones and generated) */
  exampleNames: Record<string, string[]>
  auth: Record<string, AuthProfileLike>
  secrets: Record<string, Record<string, never>>
  defaultProfile?: string
  /** absolute API address, from `servers` (resolved against the spec URL) or `host` */
  baseUrl?: string
  /** a relative `servers` entry the person has to give a base URL for */
  needsBaseUrl: boolean
  warnings: string[]
  timings: Timings
  /** bytes of the document, and of the shared definitions */
  bytes: { spec: number; definitions: number }
}

export type Request =
  | { id: number; type: 'open'; source: Source }
  | { id: number; type: 'bundle'; opId: string }
  | { id: number; type: 'definitions' }
  | { id: number; type: 'cancel' }

export type Response =
  | { id: number; ok: true; result: OpenResult | string | null }
  | {
      id: number
      ok: false
      error: string
      code?: 'cors' | 'http' | 'too-large' | 'timeout' | 'parse'
    }
  | { id: number; progress: string }
