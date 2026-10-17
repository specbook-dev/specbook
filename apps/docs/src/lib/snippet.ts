// Every block of code on the site is read from a file that CI compiles and runs, never typed into a page. A page names a
// file and, usually, a region of it; a name that does not exist fails the build, so a page cannot drift from the code.

import { readFileSync } from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'

/** `apps/docs`: astro and vitest both run from there, and the build bundles this file elsewhere, so its own path is no guide */
const docs = process.cwd()

/** Where a snippet may come from, relative to `apps/docs`: the demo project, files written for the site, the example. */
export const ROOTS = ['demo', 'snippets', '../example']

export interface SnippetRef {
  /** relative to `apps/docs`, under one of ROOTS */
  file: string
  /** the text between `#region name` and `#endregion name` */
  region?: string
  /** or a line range, `3-9`, 1-based and inclusive */
  lines?: string
  /** read from here instead of `apps/docs` (tests) */
  base?: string
  roots?: string[]
}

export interface Snippet {
  code: string
  /** the language for the highlighter, from the file's extension */
  lang: string
  /** the file's name, for the frame's title */
  name: string
}

const LANGS: Record<string, string> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.json': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.md': 'md',
  '.sh': 'sh',
  '.env': 'ini',
  '.html': 'html',
  '.css': 'css',
}

const START = /#region\s+([\w-]+)/
const END = /#endregion(?:\s+([\w-]+))?/

/** Removes the indentation every non-empty line shares. */
export function dedent(lines: string[]): string[] {
  const indents = lines
    .filter((l) => l.trim())
    .map((l) => (/^[ \t]*/.exec(l) as RegExpExecArray)[0].length)
  const cut = indents.length ? Math.min(...indents) : 0
  return lines.map((l) => l.slice(Math.min(cut, (/^[ \t]*/.exec(l) as RegExpExecArray)[0].length)))
}

/** The lines of one region, without the marker lines (nested regions' markers are dropped, their code stays). */
export function region(text: string, name: string, where = 'the file'): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => START.exec(l)?.[1] === name)
  if (start < 0) throw new Error(`${where} has no "#region ${name}"`)
  const body: string[] = []
  const open: string[] = [name]
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string
    const s = START.exec(line)
    const e = END.exec(line)
    if (s) {
      open.push(s[1] as string)
      continue
    }
    if (e) {
      const closing = e[1] ?? open[open.length - 1]
      if (closing === name) {
        // a region that holds nothing is a mistake worth failing for, not an empty block on a page
        if (!body.some((l) => l.trim())) throw new Error(`"#region ${name}" in ${where} is empty`)
        return dedent(trim(body))
      }
      const at = open.lastIndexOf(closing as string)
      if (at >= 0) open.splice(at, 1)
      continue
    }
    body.push(line)
  }
  throw new Error(`"#region ${name}" in ${where} is never closed with "#endregion ${name}"`)
}

const trim = (lines: string[]) => {
  let a = 0
  let b = lines.length
  while (a < b && !(lines[a] as string).trim()) a++
  while (b > a && !(lines[b - 1] as string).trim()) b--
  return lines.slice(a, b)
}

function range(text: string, spec: string, where: string): string[] {
  const m = /^(\d+)-(\d+)$/.exec(spec)
  if (!m) throw new Error(`lines "${spec}" in ${where} is not like 3-9`)
  const [from, to] = [Number(m[1]), Number(m[2])]
  const lines = text.split('\n')
  if (from < 1 || to < from || to > lines.length)
    throw new Error(`lines ${spec} are outside ${where}, which has ${lines.length}`)
  return dedent(lines.slice(from - 1, to))
}

/** Reads one snippet. Throws, with the file and the region, for anything a page should not be built with. */
export function readSnippet(ref: SnippetRef): Snippet {
  const base = ref.base ?? docs
  const abs = resolve(base, ref.file)
  const roots = (ref.roots ?? ROOTS).map((r) => resolve(base, r))
  if (!roots.some((r) => abs === r || abs.startsWith(r + sep)))
    throw new Error(
      `${ref.file} is not under ${(ref.roots ?? ROOTS).join(', ')}, where snippets come from`,
    )
  let text: string
  try {
    text = readFileSync(abs, 'utf8')
  } catch {
    throw new Error(`Snippet file ${ref.file} does not exist`)
  }
  const where = relative(base, abs).split(sep).join('/')
  let lines: string[]
  if (ref.region) lines = region(text, ref.region, where)
  else if (ref.lines) lines = range(text, ref.lines, where)
  else lines = trim(text.split('\n').filter((l) => !START.test(l) && !END.test(l)))
  const ext = extname(abs)
  return {
    code: lines.join('\n'),
    lang: LANGS[ext] ?? 'txt',
    name: abs.slice(abs.lastIndexOf(sep) + 1),
  }
}
