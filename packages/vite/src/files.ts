import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import fg from 'fast-glob'

const IGNORE = ['**/node_modules/**', '**/.generated/**', '**/dist/**', '**/.git/**']

export interface ProjectFiles {
  requests: string[]
  sequences: string[]
  /** every .ts/.json file the editor may need for typings (relative to root) */
  sources: string[]
}

export async function scanProject(root: string): Promise<ProjectFiles> {
  const rel = (e: string[]) => e.map((f) => relative(root, f).split(sep).join('/')).sort()
  const [requests, sequences, sources] = await Promise.all([
    fg('**/*.req.ts', { cwd: root, absolute: true, ignore: IGNORE }),
    fg('**/*.seq.ts', { cwd: root, absolute: true, ignore: IGNORE }),
    fg(['**/*.ts', '**/*.json'], {
      cwd: root,
      absolute: true,
      ignore: [
        ...IGNORE,
        '**/package.json',
        '**/tsconfig*.json',
        '**/openapi/**',
        '**/*.d.ts',
        '**/*.example.json',
      ],
    }),
  ])
  return { requests: rel(requests), sequences: rel(sequences), sources: rel(sources) }
}

/** Sources, plus the sample files an example may upload. */
const WRITABLE = /\.(ts|json|txt|csv|png|jpe?g|gif|webp|pdf|zip|bin)$/
const BLOCKED = /(^|\/)(node_modules|\.generated|\.git|dist)(\/|$)|secrets\.local\.env/

/** Resolve a project-relative path for reading/writing, or undefined when not allowed. */
export function safeProjectPath(root: string, relPath: string): string | undefined {
  if (typeof relPath !== 'string' || relPath.includes('\0')) return undefined
  const abs = resolve(root, relPath)
  const rel = relative(root, abs).split(sep).join('/')
  if (rel.startsWith('..') || rel === '' || resolve(rel) === rel) return undefined
  if (BLOCKED.test(rel) || !WRITABLE.test(rel)) return undefined
  return abs
}

export async function readDotenvFile(path: string): Promise<string> {
  return existsSync(path) ? readFile(path, 'utf8') : ''
}

export const secretsFile = (root: string) => join(root, '.specbook', 'secrets.local.env')

/** Where new example files go: `requests/`, or `apis/` for projects that already use that folder name. */
export function requestsDirFor(root: string): 'requests' | 'apis' {
  return existsSync(join(root, 'apis')) && !existsSync(join(root, 'requests')) ? 'apis' : 'requests'
}
