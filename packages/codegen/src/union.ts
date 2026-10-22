/**
 * Polymorphism: what a `oneOf`/`anyOf` is made of and how its branches are told apart. Pure and free of
 * imports, so the example generator (raw OpenAPI, `#/components/schemas/X`) and the browser UI (generated
 * definitions, `…#/$defs/X`) share one answer. `$ref`s are compared by their last path segment.
 *
 * Two ways a family says which branch a value is, both common in Spring/Jackson documents:
 * - a `discriminator`, on the union itself or on a base the branches extend through `allOf`
 *   (`mapping` keys are the values; a branch with no entry is named by its schema);
 * - a property every branch pins to its own single value with `enum`/`const` (`error: ["OUT_OF_STOCK"]`).
 */
export type Schema = Record<string, any>
export type Resolve = (ref: string) => Schema | undefined

export interface UnionContext {
  resolve: Resolve
  /** a branch that is not a real alternative (the UI's `"{{variable}}"` placeholder) */
  ignore?: (branch: Schema) => boolean
}

export interface UnionBranch {
  schema: Schema
  /** the schema's name when the branch is a `$ref`, else its `title` */
  name?: string
  /** the value of the union's tag property that selects this branch */
  tag?: string
}

export interface UnionInfo {
  /** the real alternatives, in the document's order (`null` and placeholder branches left out) */
  branches: UnionBranch[]
  tagProp?: string
  tagSource?: 'discriminator' | 'enum'
}

/** The name a `$ref` ends in. */
export const nameOf = (ref: string): string => ref.slice(ref.lastIndexOf('/') + 1)

const DEPTH = 8
/** Properties that usually tell the variants of a family apart, tried first. */
const TAG_NAMES = ['type', 'kind', 'error', 'code', 'status', 'title']

function mappedTag(discriminator: Schema, name: string): string {
  for (const [key, target] of Object.entries<unknown>(discriminator.mapping ?? {}))
    if (typeof target === 'string' && nameOf(target) === name) return key
  // OpenAPI: a schema with no mapping entry is named by itself
  return name
}

/**
 * The discriminator value a schema gets from the base it extends: `Album` is `allOf [Media, {…}]`, `Media`
 * holds `discriminator { propertyName, mapping }`, so `Album` is `{ prop, value }`. Looks through nested bases.
 */
export function subtypeTag(
  ref: string,
  ctx: UnionContext,
): { prop: string; value: string } | undefined {
  const name = nameOf(ref)
  type Found = { prop: string; value: string } | undefined
  const walk = (schema: Schema | undefined, depth: number, seen: Set<Schema>): Found => {
    if (!schema || depth > DEPTH || seen.has(schema)) return undefined
    seen.add(schema)
    for (const part of (schema.allOf as Schema[] | undefined) ?? []) {
      const base = part.$ref ? ctx.resolve(part.$ref) : part
      if (!base) continue
      if (base.discriminator?.propertyName)
        return {
          prop: base.discriminator.propertyName as string,
          value: mappedTag(base.discriminator, name),
        }
      const deeper = walk(base, depth + 1, seen)
      if (deeper) return deeper
    }
    return undefined
  }
  return walk(ctx.resolve(ref), 0, new Set())
}

/** A schema's properties with its `allOf` parts and bases folded in (the subtype's own win). */
export function flatProps(
  schema: Schema | undefined,
  ctx: UnionContext,
  depth = 0,
  seen = new Set<Schema>(),
): Record<string, Schema> {
  if (!schema || depth > DEPTH || seen.has(schema)) return {}
  seen.add(schema)
  const base = schema.$ref ? ctx.resolve(schema.$ref) : schema
  if (!base) return {}
  const out: Record<string, Schema> = {}
  for (const part of (base.allOf as Schema[] | undefined) ?? [])
    Object.assign(out, flatProps(part, ctx, depth + 1, seen))
  return Object.assign(out, base.properties ?? {})
}

/**
 * The one value a property is pinned to, if it is pinned. A string enum may arrive as `anyOf [enum, placeholder]`
 * (the browser's definitions let a request hold a `"{{variable}}"` there): the placeholder is not an alternative.
 */
export function pinnedValue(prop: Schema | undefined, ctx?: UnionContext): string | undefined {
  let p = prop
  if (Array.isArray(p?.anyOf)) {
    const real = p.anyOf.filter((b: Schema) => b.type !== 'null' && !ctx?.ignore?.(b))
    if (real.length === 1) p = real[0]
  }
  if (!p) return undefined
  const v = p.const !== undefined ? p.const : p.enum?.length === 1 ? p.enum[0] : undefined
  return typeof v === 'string' ? v : undefined
}

const memo = new WeakMap<object, UnionInfo | null>()

/** The union a schema is, or undefined when it is not one (fewer than two real alternatives is a wrapper, not a union). */
export function unionOf(schema: Schema | undefined, ctx: UnionContext): UnionInfo | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  const known = memo.get(schema)
  if (known !== undefined) return known ?? undefined
  const info = classify(schema, ctx)
  memo.set(schema, info ?? null)
  return info
}

function classify(schema: Schema, ctx: UnionContext): UnionInfo | undefined {
  const raw: Schema[] | undefined = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined
  if (!raw) return undefined
  const real = raw.filter((b) => b && b.type !== 'null' && !ctx.ignore?.(b))
  // fewer than two alternatives is a wrapper (`anyOf [x, null]`), unless the union says how to tell them apart
  if (real.length < 2 && !schema.discriminator?.propertyName) return undefined
  const branches: UnionBranch[] = real.map((b) => ({
    schema: b,
    name: b.$ref ? nameOf(b.$ref) : typeof b.title === 'string' ? b.title : undefined,
  }))
  const done = (tagProp: string, tagSource: 'discriminator' | 'enum'): UnionInfo => ({
    branches,
    tagProp,
    tagSource,
  })

  // 1. a discriminator on the union itself
  if (schema.discriminator?.propertyName) {
    for (const b of branches)
      if (b.name && b.schema.$ref) b.tag = mappedTag(schema.discriminator, b.name)
    return done(schema.discriminator.propertyName, 'discriminator')
  }

  // 2. a discriminator on a base the branches extend
  if (branches.every((b) => b.schema.$ref)) {
    const found = branches.map((b) => subtypeTag(b.schema.$ref, ctx))
    const prop = found[0]?.prop
    if (prop && found.every((f) => f?.prop === prop)) {
      branches.forEach((b, i) => {
        b.tag = found[i]?.value
      })
      return done(prop, 'discriminator')
    }
  }

  // 3. a property each branch pins to its own value
  const props = branches.map((b) => flatProps(b.schema, ctx))
  const first = Object.keys(props[0] ?? {})
  const candidates = [...TAG_NAMES.filter((n) => first.includes(n)), ...first]
  for (const prop of candidates) {
    const values = props.map((p) => pinnedValue(p[prop], ctx))
    if (values.every((v) => v !== undefined) && new Set(values).size === values.length) {
      branches.forEach((b, i) => {
        b.tag = values[i]
      })
      return done(prop, 'enum')
    }
  }
  return { branches }
}
