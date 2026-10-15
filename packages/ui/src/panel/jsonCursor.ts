import type { KeyPath } from '../schema'

export interface JsonCursor {
  /** `key`: completing a property name of the object at `path`. `value`: completing the value at `path`. */
  mode: 'key' | 'value'
  path: KeyPath
  /** the range a completion replaces: a whole string (quotes included) or the word being typed */
  from: number
  to: number
  inString: boolean
  /** what was typed so far inside the string or word */
  prefix: string
  /** key mode: properties the object already has */
  existing: Set<string>
  /** key mode in a string: a `:` already follows, so only the key is replaced */
  hasColon: boolean
}

type Frame =
  | { t: 'o'; key?: string; expectKey: boolean; keys: Set<string> }
  | { t: 'a'; index: number }

const WORD = /[\w$.+-]/

/**
 * Where the cursor is in a (possibly unfinished) JSON document: which object or value, whether a key
 * or a value is being written, and what is already there. Tolerates broken JSON, since the user is
 * mid-edit. Returns undefined at the document root or where nothing can be completed.
 */
export function jsonCursor(text: string, pos: number): JsonCursor | undefined {
  const stack: Frame[] = []
  const top = () => stack[stack.length - 1]
  let i = 0
  while (i < pos) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      let value = ''
      while (j < text.length && text[j] !== '"' && text[j] !== '\n') {
        if (text[j] === '\\') {
          value += text[j + 1] ?? ''
          j += 2
        } else value += text[j++]
      }
      const closed = text[j] === '"'
      const t = top()
      if (pos <= j || (!closed && pos <= text.length && j >= pos)) {
        // the cursor is inside this string
        const isKey = t?.t === 'o' && t.expectKey
        const to = closed ? j + 1 : pos
        let after = to
        while (/\s/.test(text[after] ?? '')) after++
        return finish({
          mode: isKey ? 'key' : 'value',
          from: i,
          to,
          inString: true,
          prefix: text.slice(i + 1, pos),
          hasColon: text[after] === ':',
        })
      }
      if (t?.t === 'o' && t.expectKey) {
        t.key = value
        t.keys.add(value)
        t.expectKey = false
      }
      i = j + 1
      continue
    }
    if (c === '{') stack.push({ t: 'o', expectKey: true, keys: new Set() })
    else if (c === '[') stack.push({ t: 'a', index: 0 })
    else if (c === '}' || c === ']') stack.pop()
    else if (c === ',') {
      const t = top()
      if (t?.t === 'o') {
        t.expectKey = true
        t.key = undefined
      } else if (t?.t === 'a') t.index++
    }
    i++
  }

  // not inside a string: the word being typed, if any
  let from = pos
  while (from > 0 && WORD.test(text[from - 1] ?? '')) from--
  let to = pos
  while (to < text.length && WORD.test(text[to] ?? '')) to++
  const t = top()
  return finish({
    mode: t?.t === 'o' && t.expectKey ? 'key' : 'value',
    from,
    to,
    inString: false,
    prefix: text.slice(from, pos),
    hasColon: false,
  })

  function finish(
    c: Pick<JsonCursor, 'mode' | 'from' | 'to' | 'inString' | 'prefix' | 'hasColon'>,
  ) {
    if (stack.length === 0) return undefined
    const path: KeyPath = []
    for (let k = 0; k < stack.length; k++) {
      const f = stack[k] as Frame
      const last = k === stack.length - 1
      if (f.t === 'o') {
        if (last && c.mode === 'key') break
        if (f.key === undefined) return undefined
        path.push(f.key)
      } else path.push(f.index)
    }
    const f = top()
    return { ...c, path, existing: f?.t === 'o' ? f.keys : new Set<string>() }
  }
}
