// The colors a terminal run prints, as HTML. Core's `createColors` emits exactly these SGR codes; a test fails if it
// learns another, so the page never shows a stray escape.

const OPEN: Record<number, string> = {
  1: 'b',
  2: 'd',
  31: 'red',
  32: 'green',
  33: 'yellow',
  36: 'cyan',
}
const CLOSE: Record<number, string[]> = {
  22: ['b', 'd'],
  39: ['red', 'green', 'yellow', 'cyan'],
  0: [],
}

const SGR = new RegExp(`${String.fromCharCode(27)}\\[(\\d+)m`, 'g')

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Escapes the text and turns SGR color codes into `<span class="a-…">`. Text with no codes comes back escaped only. */
export function ansiToHtml(text: string): string {
  let out = ''
  const open = new Set<string>()
  let last = 0
  for (const m of text.matchAll(SGR)) {
    out += escapeHtml(text.slice(last, m.index))
    last = m.index + m[0].length
    const code = Number(m[1])
    if (OPEN[code]) {
      out += `<span class="a-${OPEN[code]}">`
      open.add(OPEN[code])
    } else if (code === 0) {
      out += '</span>'.repeat(open.size)
      open.clear()
    } else if (CLOSE[code]) {
      for (const cls of CLOSE[code]) {
        if (open.delete(cls)) out += '</span>'
      }
    } else {
      throw new Error(`ansiToHtml does not know SGR code ${code}`)
    }
  }
  out += escapeHtml(text.slice(last))
  return out + '</span>'.repeat(open.size)
}
