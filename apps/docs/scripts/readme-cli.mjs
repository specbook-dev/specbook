// The README's terminal recording: an animated SVG made from the real CLI recordings in demo/captures, in a dark and a
// light version. Every line is a line the CLI printed (picked out below, with a "…" where lines are skipped), so the
// picture says what the tool says. Run `pnpm --filter docs readme:cli` after re-recording the captures.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../../..')

/** The widest line shown, in characters. A phone scales the picture down, so it stays narrow. */
export const COLS = 60
const FONT = 16
const CELL = FONT * 0.6
const LINE = 24
const PAD = 24
const BAR = 40
const LOOP = 18 // seconds

const ESC = String.fromCharCode(27)
const SGR = new RegExp(`${ESC}\\[(\\d+)m`, 'g')
export const plain = (s) => s.replace(SGR, '')

/** `[text, class]` pieces of a line that has color codes in it. */
export function pieces(line) {
  const out = []
  const open = new Set()
  const cls = () => [...open].join(' ')
  let last = 0
  for (const m of line.matchAll(SGR)) {
    if (m.index > last) out.push([line.slice(last, m.index), cls()])
    last = m.index + m[0].length
    const code = Number(m[1])
    const name = { 1: 'b', 2: 'd', 31: 'red', 32: 'green', 33: 'yellow', 36: 'cyan' }[code]
    if (name) open.add(name)
    else if (code === 22) {
      open.delete('b')
      open.delete('d')
    } else if (code === 39) for (const c of ['red', 'green', 'yellow', 'cyan']) open.delete(c)
    else if (code === 0) open.clear()
    else throw new Error(`The recording uses a color code (${code}) this picture does not know`)
  }
  if (last < line.length) out.push([line.slice(last), cls()])
  return out
}

const linesOf = (capture) =>
  capture.chunks
    .map((c) => c.data)
    .join('')
    .split('\n')

/** The first line of a recording whose text starts with `start`, as the CLI printed it. */
function pick(lines, start) {
  const hit = lines.find((l) => plain(l).trimStart().startsWith(start))
  if (!hit) throw new Error(`The recording has no line starting "${start}"`)
  return hit
}

const dim = (text) => `${ESC}[2m${text}${ESC}[22m`

/** What is shown, in order: the command, then lines of what it printed. */
export function script(pass, fail) {
  const p = linesOf(pass)
  const f = linesOf(fail)
  const prompt = (c) => `$ ${c.command}`
  return {
    pass: [
      prompt(pass),
      pick(p, 'specbook test'),
      '',
      pick(p, '✓ Get a country'),
      pick(p, '✓ Add a pet'),
      pick(p, '✓ Find pets by status'),
      pick(p, '✓ Get an order'),
      pick(p, '✓ Place an order'),
      dim('  …'),
      '',
      pick(p, 'Flows'),
      pick(p, 'Assertions'),
      dim(`exit ${pass.exit}`),
    ],
    fail: [
      prompt(fail),
      pick(f, '✓ Find pets by status'),
      pick(f, '✗ Get an order'),
      pick(f, '✓ Place an order'),
      dim('  …'),
      '',
      pick(f, '✗ still placed'),
      pick(f, '- Expected'),
      pick(f, '- "placed"'),
      pick(f, '+ "delivered"'),
      pick(f, 'at requests/petstore/get-order.req.ts'),
      '',
      pick(f, 'Flows'),
      pick(f, 'Assertions'),
      dim(`exit ${fail.exit}`),
    ],
  }
}

const THEMES = {
  dark: {
    page: '#0d1117',
    bar: '#161b22',
    text: '#e6edf3',
    dim: '#8b949e',
    green: '#3fb950',
    red: '#f85149',
    yellow: '#d29922',
    cyan: '#56d4dd',
    dots: ['#ff5f57', '#febc2e', '#28c840'],
    edge: '#30363d',
  },
  light: {
    page: '#ffffff',
    bar: '#f6f8fa',
    text: '#1f2328',
    dim: '#59636e',
    green: '#1a7f37',
    red: '#cf222e',
    yellow: '#9a6700',
    cyan: '#0a7080',
    dots: ['#ff5f57', '#febc2e', '#28c840'],
    edge: '#d0d7de',
  },
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const pct = (s) => ((s / LOOP) * 100).toFixed(3)

/** One row's keyframes: hidden, shown from `from` to `to` (seconds into the loop), hidden again. */
const frames = (name, from, to) =>
  `@keyframes ${name}{0%,${pct(from)}%{opacity:0}${pct(from + 0.01)}%,${pct(to)}%{opacity:1}${pct(to + 0.01)}%,100%{opacity:0}}`

export function buildSvg(theme, pass, fail) {
  const c = THEMES[theme]
  const { pass: a, fail: b } = script(pass, fail)
  for (const l of [...a, ...b]) {
    const w = [...plain(l)].length
    if (w > COLS)
      throw new Error(`"${plain(l)}" is ${w} characters wide; the picture allows ${COLS}`)
  }
  const rows = Math.max(a.length, b.length)
  const width = COLS * CELL + PAD * 2
  const height = BAR + rows * LINE + PAD * 1.5
  const css = []
  const body = []
  let n = 0
  // a group is a run: its command appears, then each line a beat after the one before
  const group = (name, lines, start, end) => {
    body.push(`<g class="${name}">`)
    lines.forEach((line, i) => {
      if (line === '') return
      const id = `k${n++}`
      const from = i === 0 ? start : start + 0.6 + i * 0.22
      css.push(frames(id, from, end))
      const y = BAR + PAD + i * LINE
      const spans = pieces(line)
        .map(([t, cl]) => `<tspan${cl ? ` class="${cl}"` : ''}>${esc(t)}</tspan>`)
        .join('')
      body.push(
        `<text class="r" x="${PAD}" y="${y}" style="animation:${id} ${LOOP}s linear infinite" xml:space="preserve">${spans}</text>`,
      )
    })
    body.push('</g>')
  }
  group('pass', a, 0.4, 7.2)
  group('fail', b, 7.6, 16.6)
  const dots = c.dots
    .map((d, i) => `<circle cx="${PAD + i * 18}" cy="${BAR / 2}" r="5.5" fill="${d}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="t d">
<title id="t">specbook test: a passing run, then a failing check</title>
<desc id="d">A terminal runs specbook test. Every request passes. After the API changes, the run fails and shows the check that broke: expected "placed", received "delivered", exit code 1.</desc>
<style>
text{font:${FONT}px ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono","DejaVu Sans Mono",monospace;fill:${c.text};white-space:pre}
.b{font-weight:700}.d{fill:${c.dim}}.green{fill:${c.green}}.red{fill:${c.red}}.yellow{fill:${c.yellow}}.cyan{fill:${c.cyan}}
.r{opacity:0}
${css.join('\n')}
@media (prefers-reduced-motion:reduce){.r{animation:none}.pass{display:none}.fail .r{opacity:1}}
</style>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${c.page}" stroke="${c.edge}"/>
<path d="M0.5 ${BAR}V10.5a10 10 0 0 1 10-10h${width - 21}a10 10 0 0 1 10 10V${BAR}z" fill="${c.bar}"/>
${dots}
${body.join('\n')}
</svg>
`
}

async function main() {
  const read = async (n) =>
    JSON.parse(await readFile(join(root, `apps/docs/demo/captures/${n}.json`), 'utf8'))
  const pass = await read('test-pass')
  const fail = await read('test-fail')
  for (const theme of ['dark', 'light']) {
    const file = join(root, `.github/cli-${theme}.svg`)
    await writeFile(file, buildSvg(theme, pass, fail))
    console.log(`wrote ${file}`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
