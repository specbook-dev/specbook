import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SequenceMeta {
  id: string
  title: string
  description?: string
  tags?: string[]
  group?: string
}

const KEYS = ['id', 'title', 'description', 'group', 'tags'] as const

/** Reads a quoted string literal at `i`, returning its value and the index after it. */
function readString(src: string, i: number): [string, number] | undefined {
  const q = src[i]
  if (q !== "'" && q !== '"' && q !== '`') return undefined
  let out = ''
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j] as string
    if (c === '\\') {
      const n = src[j + 1] as string
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n
      j++
    } else if (c === q) return [out, j + 1]
    else if (q === '`' && c === '$' && src[j + 1] === '{') return undefined
    else out += c
  }
  return undefined
}

const skipSpace = (src: string, i: number) => {
  while (i < src.length) {
    if (/\s/.test(src[i] as string)) i++
    else if (src.startsWith('//', i))
      i = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i)
    else if (src.startsWith('/*', i))
      i = src.indexOf('*/', i) < 0 ? src.length : src.indexOf('*/', i) + 2
    else break
  }
  return i
}

/** Index after the value starting at `i` (strings, brackets, and anything up to the next `,`/`}`). */
function skipValue(src: string, i: number): number {
  let depth = 0
  for (let j = i; j < src.length; j++) {
    const c = src[j] as string
    const s = readString(src, j)
    if (s) j = s[1] - 1
    else if (c === '`' || c === "'" || c === '"') return src.length
    else if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) {
      if (depth === 0) return j
      depth--
    } else if (c === ',' && depth === 0) return j
  }
  return src.length
}

/**
 * Pulls `id`, `title`, `description`, `group` and `tags` out of the `sequence({ ... })` call in a `.seq.ts`
 * without importing it. Returns undefined when any of them is not a plain literal (computed titles,
 * concatenation, ...), so the caller can import that file instead.
 */
export function parseSequenceMeta(src: string): SequenceMeta | undefined {
  const call = /\bsequence\s*(?:<[^>]*>)?\s*\(\s*\{/.exec(src)
  if (!call) return undefined
  const found: Record<string, unknown> = {}
  let i = call.index + call[0].length
  for (;;) {
    i = skipSpace(src, i)
    if (i >= src.length || src[i] === '}') break
    const key = /^[A-Za-z_$][\w$]*|^(['"])(.*?)\1/.exec(src.slice(i))
    if (!key) return undefined
    const name = key[2] ?? key[0]
    i = skipSpace(src, i + key[0].length)
    if (src[i] !== ':') {
      // shorthand `id,` or a method; either way not a literal
      if ((KEYS as readonly string[]).includes(name)) return undefined
      i = skipValue(src, i)
    } else {
      i = skipSpace(src, i + 1)
      if ((KEYS as readonly string[]).includes(name)) {
        const str = readString(src, i)
        if (str) {
          found[name] = str[0]
          i = str[1]
        } else if (src[i] === '[' && name === 'tags') {
          const tags: string[] = []
          i++
          for (;;) {
            i = skipSpace(src, i)
            if (src[i] === ']') {
              i++
              break
            }
            const t = readString(src, i)
            if (!t) return undefined
            tags.push(t[0])
            i = skipSpace(src, t[1])
            if (src[i] === ',') i++
          }
          found[name] = tags
        } else return undefined
        i = skipSpace(src, i)
        if (src[i] !== ',' && src[i] !== '}') return undefined // e.g. 'a' + 'b'
      } else i = skipValue(src, i)
    }
    i = skipSpace(src, i)
    if (src[i] === ',') i++
  }
  if (typeof found.id !== 'string' || typeof found.title !== 'string') return undefined
  return found as unknown as SequenceMeta
}

export interface SequenceScan {
  /** keyed by id, with the project-relative file it came from */
  meta: Record<string, SequenceMeta & { file: string }>
  /** files whose header is not plain literals; the UI imports these */
  unresolved: string[]
}

export async function scanSequences(root: string, files: string[]): Promise<SequenceScan> {
  const meta: SequenceScan['meta'] = {}
  const unresolved: string[] = []
  await Promise.all(
    files.map(async (file) => {
      const parsed = parseSequenceMeta(await readFile(join(root, file), 'utf8').catch(() => ''))
      if (parsed) meta[parsed.id] = { ...parsed, file }
      else unresolved.push(file)
    }),
  )
  return { meta, unresolved: unresolved.sort() }
}
