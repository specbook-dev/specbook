import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cliVersion } from '../version'

/** The instruction files agents read: Claude Code reads CLAUDE.md, and AGENTS.md when there is none; other tools read AGENTS.md. */
const FILES = ['AGENTS.md', 'CLAUDE.md']

const START = '<!-- specbook:start'
const END = '<!-- specbook:end -->'

/** The short section that goes into a project's own instruction file; the full guide is a file beside the config. */
export function agentBlock(eol = '\n'): string {
  return [
    `${START} (written by specbook init; \`specbook init --agents\` refreshes it) -->`,
    '## Specbook',
    '',
    'This project uses Specbook: requests (`requests/**/*.req.ts`) and flows (`sequences/**/*.seq.ts`) built from OpenAPI specs run as',
    'the docs, as tests and as monitors. Before adding or changing one, read `.specbook/agent-guide.md`. In short:',
    '',
    '- Import operations from `#api/<service>`. Never edit `.generated/`.',
    '- Label every `assert`, and use `capture` to pass values between steps.',
    '- Write isomorphic code: requests and flows also run in the browser, so no Node built-ins, `Buffer` or `process.env`.',
    '- Run `npx specbook check` and `npx specbook test` before you finish.',
    END,
  ].join(eol)
}

export type BlockResult = {
  text: string
  status: 'added' | 'updated' | 'unchanged' | 'unterminated'
}

/** The file's text with Specbook's block in it: replaced in place when its markers are there, appended when they are not. */
export function withBlock(text: string): BlockResult {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const block = agentBlock(eol)
  const start = text.indexOf(START)
  if (start >= 0) {
    const end = text.indexOf(END, start)
    // a start with no end: anything after it could be someone else's text, so it is left alone
    if (end < 0) return { text, status: 'unterminated' }
    const next = text.slice(0, start) + block + text.slice(end + END.length)
    return { text: next, status: next === text ? 'unchanged' : 'updated' }
  }
  if (!text.trim()) return { text: `${block}${eol}`, status: 'added' }
  const lead = text.endsWith('\n') ? '' : eol
  return { text: `${text}${lead}${eol}${block}${eol}`, status: 'added' }
}

/** A CLAUDE.md that imports AGENTS.md (`@AGENTS.md`) already shows Claude whatever AGENTS.md says. */
export const importsAgents = (text: string): boolean => /^@AGENTS\.md\b/m.test(text)

/** The guide that ships beside this code, found from the built file (`dist/`) or the source (`src/commands/`). */
export async function readGuide(): Promise<string> {
  for (const rel of ['../agent-guide.md', '../../agent-guide.md'])
    try {
      return await readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    } catch {
      /* the other layout */
    }
  throw new Error('agent-guide.md is missing from the @specbook/cli package')
}

/**
 * Writes `.specbook/agent-guide.md`, and puts a pointer to it where agents read. `agents` is undefined by default (create
 * AGENTS.md when there is none, never touch one that exists), true for `--agents` (add or refresh the block), false for
 * `--no-agents` (do nothing).
 */
export async function agentsStep(cwd: string, agents?: boolean): Promise<void> {
  if (agents === false) return
  const dir = join(cwd, '.specbook')
  await mkdir(dir, { recursive: true })
  const guide = await readGuide()
  await writeFile(
    join(dir, 'agent-guide.md'),
    `<!-- Written by specbook init v${cliVersion()}. Re-run \`specbook init\` to refresh it, and put project rules in AGENTS.md. -->\n\n${guide}`,
  )
  console.log('✓ wrote .specbook/agent-guide.md')

  // a symlinked CLAUDE.md -> AGENTS.md is one file
  const seen = new Set<string>()
  const found: string[] = []
  for (const f of FILES) {
    if (!existsSync(join(cwd, f))) continue
    const real = realpathSync(join(cwd, f))
    if (seen.has(real)) continue
    seen.add(real)
    found.push(f)
  }

  if (found.length === 0) {
    await writeFile(
      join(cwd, 'AGENTS.md'),
      `# AGENTS.md\n\nInstructions for AI coding agents working in this repository.\n\n${agentBlock()}\n`,
    )
    console.log('✓ created AGENTS.md (read by Claude Code, Codex and other coding agents)')
    return
  }
  if (!agents) {
    console.log(
      `${found.join(' and ')} already ${found.length > 1 ? 'exist' : 'exists'} and was not changed. To add Specbook's section to ${found.length > 1 ? 'them' : 'it'}: specbook init --agents`,
    )
    return
  }
  for (const file of found) {
    const path = join(cwd, file)
    const text = await readFile(path, 'utf8')
    if (file === 'CLAUDE.md' && found.includes('AGENTS.md') && importsAgents(text)) {
      console.log('CLAUDE.md imports AGENTS.md: its section covers Claude Code too')
      continue
    }
    const r = withBlock(text)
    if (r.status === 'unterminated') {
      console.log(`! ${file} has a "${START}" marker with no end marker; left unchanged`)
      continue
    }
    if (r.status === 'unchanged') {
      console.log(`${file} already has Specbook's section`)
      continue
    }
    await writeFile(path, r.text)
    console.log(`✓ ${r.status === 'added' ? 'added' : 'updated'} Specbook's section in ${file}`)
  }
}
