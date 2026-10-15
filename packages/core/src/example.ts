import { flattenForm, isBlob } from './runner/encode'
import type { OpMeta } from './types'

/** A complete request an API author (or the spec) defines for an operation. */
export interface Example {
  name: string
  title?: string
  summary?: string
  source: 'spec' | 'generated' | 'project'
  path?: Record<string, unknown>
  /** Arrays send the same key repeatedly. */
  query?: Record<string, unknown>
  headers?: Record<string, string>
  body?: unknown
  /** Directory file-field paths are relative to; set by whoever loads the example. */
  dir?: string
}

export type ExampleLoader = (op: OpMeta, name: string) => Promise<Example | undefined>
export type FileReader = (path: string, dir?: string) => Promise<File>

/** One line of an inline grid editor. Disabled rows stay visible but are not sent. */
export interface Row {
  key: string
  value: string
  enabled: boolean
}

const text = (v: unknown) =>
  typeof v === 'string' ? v : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)

export function toRows(o: Record<string, unknown> = {}): Row[] {
  return Object.entries(o).flatMap(([key, v]) =>
    (Array.isArray(v) ? v : [v])
      .filter((x) => x !== undefined && x !== null)
      .map((x) => ({ key, value: text(x), enabled: true })),
  )
}

export function fromRows(rows: Row[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const { key, value, enabled } of rows) {
    if (!enabled || key === '') continue
    const had = out[key]
    out[key] = had === undefined ? value : [...(Array.isArray(had) ? had : [had]), value]
  }
  return out
}

/** Rows for a form/multipart body: nested values become bracket keys (`metadata[order]`). Files stay as values. */
export function toFormRows(body: unknown): Row[] {
  if (body === null || typeof body !== 'object') return []
  return flattenForm(body).map(([key, value]) => ({ key, value, enabled: true }))
}

const SEGMENT = /[^[\]]+|\[\]/g

function assign(node: any, segs: string[], value: unknown): any {
  const [head, ...rest] = segs as [string, ...string[]]
  if (head === '[]') {
    const list: unknown[] = node ?? []
    list.push(rest.length ? assign(undefined, rest, value) : value)
    return list
  }
  const target = node ?? (/^\d+$/.test(head) ? [] : {})
  const had = target[head]
  if (rest.length) target[head] = assign(had, rest, value)
  else target[head] = had === undefined ? value : [...([] as unknown[]).concat(had), value]
  return target
}

/** Inverse of `toFormRows`; disabled rows are dropped and a repeated plain key becomes an array. */
export function fromFormRows(rows: (Row & { file?: File })[]): Record<string, unknown> {
  let out: Record<string, unknown> = {}
  for (const { key, value, enabled, file } of rows) {
    if (!enabled || key === '') continue
    out = assign(out, key.match(SEGMENT) ?? [key], file && isBlob(file) ? file : value)
  }
  return out
}
