import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSvg, COLS, plain, script } from '../scripts/readme-cli.mjs'

/** The README's terminal recording is made from the real recordings; these keep it true to them and readable on a phone. */

const root = join(import.meta.dirname, '../../..')
const read = async (name: string) =>
  JSON.parse(await readFile(join(root, `apps/docs/demo/captures/${name}.json`), 'utf8'))

describe('the README terminal recording', () => {
  it('shows only lines the CLI printed, none wider than the picture allows', async () => {
    const pass = await read('test-pass')
    const fail = await read('test-fail')
    const { pass: a, fail: b } = script(pass, fail)
    const printed = (c: { chunks: { data: string }[] }) =>
      plain(c.chunks.map((x) => x.data).join(''))
    for (const [lines, capture] of [
      [a, pass],
      [b, fail],
    ] as const) {
      for (const l of lines.slice(1)) {
        const text = plain(l)
        // the command line, the exit code and the "…" for skipped lines are added; everything else was printed
        if (text === '' || text.trim() === '…' || text.startsWith('exit ')) continue
        expect(printed(capture), text).toContain(text)
      }
      for (const l of lines) expect([...plain(l)].length).toBeLessThanOrEqual(COLS)
    }
    // the story: it passes, then a check fails with what was expected and received, and the exit code says so
    expect(a.map(plain).at(-1)).toBe('exit 0')
    expect(b.map(plain).join('\n')).toMatch(/✗ still placed[\s\S]*- Expected[\s\S]*"delivered"/)
    expect(b.map(plain).at(-1)).toBe('exit 1')
  })

  it('is a dark and a light picture that moves, and holds still for people who ask for less motion', async () => {
    const pass = await read('test-pass')
    const fail = await read('test-fail')
    const dark = buildSvg('dark', pass, fail)
    const light = buildSvg('light', pass, fail)
    expect(dark).not.toBe(light)
    for (const svg of [dark, light]) {
      expect(svg).toContain('@keyframes')
      expect(svg).toContain('prefers-reduced-motion')
      expect(svg).toContain('role="img"')
      expect(svg).toContain('<title')
      // nothing from the output is left unescaped inside the markup
      expect(svg).not.toMatch(/<tspan[^>]*>[^<]*[&](?!amp;|lt;|gt;)/)
    }
  })

  it('is what is committed: regenerate with `pnpm --filter docs readme:cli` after re-recording', async () => {
    const pass = await read('test-pass')
    const fail = await read('test-fail')
    for (const theme of ['dark', 'light']) {
      const committed = await readFile(join(root, `.github/cli-${theme}.svg`), 'utf8')
      expect(committed).toBe(buildSvg(theme, pass, fail))
    }
  })
})
