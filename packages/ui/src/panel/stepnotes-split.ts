export interface SequenceNotes {
  /** the page without the sections that belong to steps */
  intro: string
  /** step name -> HTML of the section headed by that name */
  notes: Map<string, string>
}

/** The text of a heading, without tags or entities. */
const plain = (h: string) =>
  h
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * A `## Heading` that names a step becomes that step's note (everything up to the next `##`).
 * Anything else stays in the intro, so ordinary headings keep working.
 */
export function splitStepNotes(html: string, stepNames: string[]): SequenceNotes {
  const notes = new Map<string, string>()
  if (!html || stepNames.length === 0) return { intro: html, notes }
  const wanted = new Map(stepNames.map((n) => [norm(n), n]))
  const intro: string[] = []
  // the page is rendered markdown, so every `##` is an <h2> at the top level
  for (const chunk of html.split(/(?=<h2[ >])/)) {
    const m = /^<h2[^>]*>([\s\S]*?)<\/h2>/.exec(chunk)
    const name = m ? wanted.get(norm(plain(m[1] as string))) : undefined
    if (m && name !== undefined) {
      if (!notes.has(name)) notes.set(name, chunk.slice(m[0].length))
    } else intro.push(chunk)
  }
  return { intro: intro.join(''), notes }
}
