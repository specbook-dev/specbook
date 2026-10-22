import {
  type Defs,
  describe,
  type JsonSchema,
  kindOf,
  propsOf,
  schemaAt,
  summary,
  typeInfo,
  unionFor,
  unwrap,
} from '../schema'
import { jsonCursor } from './jsonCursor'

/** The shape the editor's autocomplete extension consumes (see prism-code-editor's `CompletionResult`). */
export interface Option {
  label: string
  detail?: string
  icon?: string
  insert?: string
  tabStops?: number[]
  boost?: number
  from?: number
  /** a longer description for the documentation popup */
  doc?: string
}
export interface Completions {
  from: number
  to: number
  options: Option[]
}

/** Descriptions are markdown; the popup shows plain text, so links keep just their label. */
const plain = (s: string | undefined) =>
  s?.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_]{1,2}/g, '')

/** The empty value of the right kind that goes after `"key": `, with the cursor placed inside it. */
function skeleton(u: JsonSchema): { text: string; stop: number } {
  const kind = kindOf(u)
  if (kind === 'object') return { text: '{}', stop: 1 }
  if (kind === 'array') return { text: '[]', stop: 1 }
  if (kind === 'boolean') return { text: 'false', stop: 5 }
  if (kind === 'number' || kind === 'integer') return { text: '0', stop: 1 }
  return { text: '""', stop: 1 }
}

/**
 * Completions for the JSON body editor: the properties the schema allows at the cursor (minus the ones
 * already there), or the allowed values for the property being written. `root` is the request schema and
 * `prefix` the path of the body inside it (`['data']`).
 */
export function jsonCompletions(
  root: JsonSchema | undefined,
  defs: Defs,
  prefix: (string | number)[],
  text: string,
  pos: number,
): Completions | undefined {
  if (!root) return undefined
  const cur = jsonCursor(text, pos)
  if (!cur) return undefined
  const base = schemaAt(root, prefix, defs)
  if (!base) return undefined
  // what has been written on the way to the cursor lets the schema follow a union by its tag
  const walk = (path: (string | number)[]) => schemaAt(base, path, defs, cur.skeleton)
  const at = walk(cur.path)

  const values: Option[] = []
  const add = (v: unknown, detail?: string) => {
    const json = JSON.stringify(v)
    values.push({
      label: typeof v === 'string' ? v : json,
      insert: json,
      icon: 'enum',
      detail,
      from: cur.inString ? cur.from + 1 : undefined,
    })
  }

  // the value of the property that tells the variants of a union apart: the variants' tags
  if (cur.mode === 'value') {
    const key = cur.path[cur.path.length - 1]
    const holder = typeof key === 'string' ? walk(cur.path.slice(0, -1)) : undefined
    const family = holder ? unionFor(holder, defs) : undefined
    if (family?.tagProp === key) {
      for (const b of family.branches) if (b.tag !== undefined) add(b.tag, b.name)
      if (values.length) return { from: cur.from, to: cur.to, options: values }
    }
  }
  if (!at) return undefined
  const u = unwrap(at, defs)

  if (cur.mode === 'key') {
    const family = unionFor(at, defs)
    if (!family && kindOf(u) !== 'object' && !u.properties) return undefined
    // inside a union: the variant the object already names, else every variant's fields with whose they are
    const named = family?.tagProp
      ? family.branches.find(
          (b) => b.tag !== undefined && b.tag === cur.values[family.tagProp as string],
        )
      : undefined
    const owners = new Map<string, string[]>()
    let all: ReturnType<typeof propsOf>
    if (family && !named) {
      const seen = new Map<string, ReturnType<typeof propsOf>[number]>()
      for (const b of family.branches)
        for (const p of propsOf(b.schema, defs)) {
          if (!seen.has(p.name)) seen.set(p.name, p)
          owners.set(p.name, [...(owners.get(p.name) ?? []), b.name ?? 'variant'])
        }
      all = [...seen.values()]
    } else all = propsOf(named ? named.schema : u, defs)
    const props = all.filter((p) => !cur.existing.has(p.name))
    if (props.length === 0) return undefined
    const options: Option[] = props.map((p) => {
      const pu = unwrap(p.schema, defs)
      const sk = skeleton(pu)
      const key = JSON.stringify(p.name)
      const head = cur.hasColon ? key : `${key}: `
      const insert = cur.hasColon ? key : `${head}${sk.text}`
      const whose = owners.get(p.name)
      const only = whose && family && whose.length < family.branches.length ? whose : undefined
      return {
        label: p.name,
        detail: `${typeInfo(p.schema, defs).text}${p.required ? ' · required' : ''}${only ? ` · ${only.join(' / ')}` : ''}`,
        icon: pu.deprecated ? 'text' : 'property',
        insert,
        tabStops: cur.hasColon ? undefined : [head.length + sk.stop],
        // the property that tells the variants apart is the one to write first
        boost: family?.tagProp === p.name && !named ? 20 : p.required ? 10 : 0,
        // inside a string the filter should match the letters typed after the opening quote
        from: cur.inString ? cur.from + 1 : undefined,
        doc: plain(summary(describe(pu), 400)),
      }
    })
    return { from: cur.from, to: cur.to, options }
  }

  // value mode
  if (Array.isArray(u.enum)) for (const v of u.enum) add(v)
  else if (kindOf(u) === 'boolean') {
    add(true)
    add(false)
  } else return undefined
  if (u.nullable === true) add(null, 'null')
  return { from: cur.from, to: cur.to, options: values }
}
