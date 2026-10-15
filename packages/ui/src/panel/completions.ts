import {
  type Defs,
  describe,
  type JsonSchema,
  kindOf,
  propsOf,
  schemaAt,
  summary,
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

const typeLabel = (u: JsonSchema, defs: Defs) => {
  const kind = kindOf(u)
  if (kind === 'array') return `${kindOf(unwrap(u.items, defs))}[]`
  return u.format ? `${kind} · ${u.format}` : kind
}

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
  const at = schemaAt(root, [...prefix, ...cur.path], defs)
  if (!at) return undefined
  const u = unwrap(at, defs)

  if (cur.mode === 'key') {
    if (kindOf(u) !== 'object' && !u.properties) return undefined
    const props = propsOf(u, defs).filter((p) => !cur.existing.has(p.name))
    if (props.length === 0) return undefined
    const options: Option[] = props.map((p) => {
      const pu = unwrap(p.schema, defs)
      const sk = skeleton(pu)
      const key = JSON.stringify(p.name)
      const head = cur.hasColon ? key : `${key}: `
      const insert = cur.hasColon ? key : `${head}${sk.text}`
      return {
        label: p.name,
        detail: `${typeLabel(pu, defs)}${p.required ? ' · required' : ''}`,
        icon: pu.deprecated ? 'text' : 'property',
        insert,
        tabStops: cur.hasColon ? undefined : [head.length + sk.stop],
        boost: p.required ? 10 : 0,
        // inside a string the filter should match the letters typed after the opening quote
        from: cur.inString ? cur.from + 1 : undefined,
        doc: plain(summary(describe(pu), 400)),
      }
    })
    return { from: cur.from, to: cur.to, options }
  }

  // value mode
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
  if (Array.isArray(u.enum)) for (const v of u.enum) add(v)
  else if (kindOf(u) === 'boolean') {
    add(true)
    add(false)
  } else return undefined
  if (u.nullable === true) add(null, 'null')
  return { from: cur.from, to: cur.to, options: values }
}
