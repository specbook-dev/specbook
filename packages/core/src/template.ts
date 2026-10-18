// Template engine: `{{ name }}` placeholders, variable lookup only (no expressions).

import { faker } from './faker'

// a name is words joined by dots, and a position in an array can be a dot (`tags.0.name`) or brackets (`tags[0].name`)
const NAME = String.raw`[\w.$\[\]-]+`
const WHOLE = new RegExp(String.raw`^\s*\{\{\s*(${NAME})\s*\}\}\s*$`)
const EMBED = new RegExp(String.raw`\{\{\s*(${NAME})\s*\}\}`, 'g')

/** The variable a placeholder starts from: `tags` for `tags[0].name`, `pet` for `pet.category.name`. */
export const rootName = (name: string): string => name.split(/[.[]/, 1)[0] as string

/** Namespaces resolved at the transport boundary, never in the request model. */
export const DEFERRED_NAMESPACES = ['secrets', 'session'] as const

export class TemplateError extends Error {
  constructor(readonly variable: string) {
    super(`Missing variable "{{${variable}}}"`)
    this.name = 'TemplateError'
  }
}

export function isDeferred(name: string): boolean {
  const ns = name.split('.')[0]
  return (DEFERRED_NAMESPACES as readonly string[]).includes(ns as string) && name.includes('.')
}

export const isFakerName = (name: string) => name.startsWith('faker.')

/** `faker.person.firstName` calls the generator on the active faker instance, fresh on every render. */
function fromFaker(path: string): { found: boolean; value?: unknown } {
  let parent: any = faker
  let cur: any = faker
  for (const part of path.split('.').slice(1)) {
    parent = cur
    cur = cur?.[part]
    if (cur === undefined) return { found: false }
  }
  return { found: true, value: typeof cur === 'function' ? cur.call(parent) : cur }
}

/** True when any placeholder in `value` needs the faker instance. */
export function usesFaker(value: unknown): boolean {
  return [...collectPlaceholders(value)].some(isFakerName)
}

/** `tags[0].name` is `tags.0.name`: a position in brackets is the same step as one after a dot. */
const steps = (path: string) => path.replace(/\[(\d+)\]/g, '.$1').split('.')

function lookup(scope: Record<string, unknown>, path: string): { found: boolean; value?: unknown } {
  if (isFakerName(path)) return fromFaker(path)
  let cur: unknown = scope
  for (const part of steps(path)) {
    // a value's own properties only: `toString` and `constructor` are not data, so a placeholder cannot reach them
    if (cur !== null && typeof cur === 'object' && Object.hasOwn(cur as object, part)) {
      cur = (cur as Record<string, unknown>)[part]
    } else {
      return { found: false }
    }
  }
  return { found: true, value: cur }
}

export function renderString(s: string, scope: Record<string, unknown>): unknown {
  const whole = WHOLE.exec(s)
  if (whole) {
    const name = whole[1] as string
    if (isDeferred(name)) return s
    const r = lookup(scope, name)
    if (!r.found) throw new TemplateError(name)
    return r.value
  }
  return s.replace(EMBED, (m, name: string) => {
    if (isDeferred(name)) return m
    const r = lookup(scope, name)
    if (!r.found) throw new TemplateError(name)
    const v = r.value
    return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)
  })
}

/** Deeply render every string leaf. Deferred placeholders (secrets.*, session.*) are left intact. */
export function render<T>(value: T, scope: Record<string, unknown>): T {
  if (typeof value === 'string') return renderString(value, scope) as T
  if (isBlob(value)) return value
  if (Array.isArray(value)) return value.map((v) => render(v, scope)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = render(v, scope)
    return out as T
  }
  return value
}

/** All placeholder names referenced by a value (including deferred ones). */
export function collectPlaceholders(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(EMBED)) into.add(m[1] as string)
  } else if (Array.isArray(value)) {
    for (const v of value) collectPlaceholders(v, into)
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) collectPlaceholders(v, into)
  }
  return into
}

const isBlob = (v: unknown) => typeof Blob !== 'undefined' && v instanceof Blob

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !isBlob(v)
}

/** Objects merge recursively; arrays and scalars in `patch` replace. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch))
    return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v)
  return out as T
}
