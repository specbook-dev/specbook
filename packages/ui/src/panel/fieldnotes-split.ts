/** Section a field belongs to in a request schema (`{ path, query, headers, data }`). */
export type FieldSection = 'path' | 'query' | 'headers' | 'data'

const SECTIONS = new Set<string>(['path', 'query', 'headers', 'data'])

export interface FieldNotes {
  /** the page without the field sections */
  intro: string
  /** `section.path` -> HTML, e.g. `data.address.city` */
  notes: Map<string, string>
}

/** `items[0].price` and `items.price` are the same field. */
const segments = (s: string) => (s.match(/[^.[\]]+/g) ?? []).filter((p) => !/^\d+$/.test(p))

/** The key notes are stored and looked up by. */
export function noteKey(section: FieldSection, path: string): string {
  return [section, ...segments(path)].join('.')
}

/** A heading's text becomes a key when it names a field: `name`, `data.name`, `query.status`. */
function headingKey(text: string): string | undefined {
  const parts = segments(text.trim())
  if (parts.length === 0) return undefined
  const first = parts[0] as string
  if (parts.length >= 2 && SECTIONS.has(first)) return parts.join('.')
  return ['data', ...parts].join('.')
}

const plain = (h: string) =>
  h
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')

/**
 * A heading made of one inline code span (`## \`data.name\``) attaches the text under it, up to the next
 * heading of that kind, to that field. Everything else stays in the intro.
 */
export function splitFieldNotes(html: string): FieldNotes {
  const notes = new Map<string, string>()
  if (!html) return { intro: html, notes }
  const intro: string[] = []
  for (const chunk of html.split(/(?=<h[1-6][ >])/)) {
    const m = /^<h([1-6])[^>]*>\s*<code>([^<]+)<\/code>\s*<\/h\1>/.exec(chunk)
    const key = m ? headingKey(plain(m[2] as string)) : undefined
    if (m && key) {
      const prev = notes.get(key)
      const body = chunk.slice(m[0].length)
      notes.set(key, prev ? prev + body : body)
    } else intro.push(chunk)
  }
  return { intro: intro.join(''), notes }
}
