/**
 * `{{secrets.NAME}}` substitution that works on bytes, so an upload or a multipart body passes through
 * untouched and only the placeholders change. Written without `TextDecoder('latin1')`, which is really
 * windows-1252 and would alter bytes 0x80-0x9f. Runs in Node, Workers, browsers and extension workers.
 */

const OPEN = 0x7b // {
const CLOSE = 0x7d // }
const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d
const isName = (c: number) =>
  (c >= 0x30 && c <= 0x39) ||
  (c >= 0x41 && c <= 0x5a) ||
  (c >= 0x61 && c <= 0x7a) ||
  c === 0x5f ||
  c === 0x24 ||
  c === 0x2d
const PREFIX = [0x73, 0x65, 0x63, 0x72, 0x65, 0x74, 0x73, 0x2e] // "secrets."

interface Hit {
  start: number
  end: number
  name: string
}

/** The placeholder starting at `i` (which is a `{{`), if it is one. */
function placeholderAt(b: Uint8Array, i: number): Hit | undefined {
  let p = i + 2
  while (p < b.length && isSpace(b[p] as number)) p++
  for (const c of PREFIX) if (b[p++] !== c) return undefined
  const from = p
  while (p < b.length && isName(b[p] as number)) p++
  if (p === from) return undefined
  const name = String.fromCharCode(...b.subarray(from, p))
  while (p < b.length && isSpace(b[p] as number)) p++
  if (b[p] !== CLOSE || b[p + 1] !== CLOSE) return undefined
  return { start: i, end: p + 2, name }
}

function find(b: Uint8Array): Hit[] {
  const out: Hit[] = []
  for (let i = 0; i < b.length - 1; i++) {
    if (b[i] === OPEN && b[i + 1] === OPEN) {
      const hit = placeholderAt(b, i)
      if (hit) {
        out.push(hit)
        i = hit.end - 1
      }
    }
  }
  return out
}

const enc = new TextEncoder()

/** Names of the secrets a body asks for. */
export function secretNames(bytes: Uint8Array): string[] {
  return [...new Set(find(bytes).map((h) => h.name))]
}

/** Names in a string (headers, query). */
export function secretNamesIn(text: string): string[] {
  return text.includes('{{') ? secretNames(enc.encode(text)) : []
}

/**
 * Replaces each placeholder whose name is in `values`, as the value's UTF-8 bytes. Placeholders with no
 * value stay as they are. Returns the same array when nothing changed.
 */
export function substituteBytes(bytes: Uint8Array, values: Map<string, string>): Uint8Array {
  const hits = find(bytes).filter((h) => values.has(h.name))
  if (hits.length === 0) return bytes
  const parts: Uint8Array[] = []
  let at = 0
  for (const h of hits) {
    parts.push(bytes.subarray(at, h.start), enc.encode(values.get(h.name) as string))
    at = h.end
  }
  parts.push(bytes.subarray(at))
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const dec = new TextDecoder()

/** The same for a string (headers and query, which are text). */
export function substituteText(text: string, values: Map<string, string>): string {
  if (!text.includes('{{')) return text
  return dec.decode(substituteBytes(enc.encode(text), values))
}
