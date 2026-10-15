import { readFile } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import fg from 'fast-glob'
import { marked } from 'marked'

export interface DocPage {
  file: string
  /** `service/OperationId` */
  operation?: string
  sequence?: string
  /** project-relative `.seq.ts` that sits beside a `<name>.seq.md` */
  sequenceFile?: string
  /** project-relative `.req.ts` that sits beside a `<name>.req.md` */
  requestFile?: string
  /** frontmatter `replace: true`: the page stands in for the spec's own description */
  replace?: boolean
  title?: string
  html: string
}

export function frontmatter(src: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  if (!m) return { meta: {}, body: src }
  const meta: Record<string, string> = {}
  for (const line of (m[1] as string).split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0)
      meta[line.slice(0, i).trim()] = line
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, '')
  }
  return { meta, body: src.slice(m[0].length) }
}

const OP_FOLDER = /(?:^|\/)(?:requests|apis)\/([^/]+)\/([^/]+)\/(?:readme|index)\.md$/i
/** `requests/<service>/docs/<Operation>.md`: one folder per service, instead of one per operation. */
const OP_FLAT = /(?:^|\/)(?:requests|apis)\/([^/]+)\/docs\/([^/]+)\.md$/i
/** Names that are about the folder, not an operation. */
const NOT_AN_OPERATION = /^(readme|index)$/i

/**
 * Where a page belongs, from its place on disk: `<name>.seq.md` beside `<name>.seq.ts`,
 * `<name>.req.md` beside `<name>.req.ts`, `requests/<service>/<Operation>/README.md`, or the flat
 * `requests/<service>/docs/<Operation>.md`.
 */
export function colocated(
  file: string,
): Pick<DocPage, 'operation' | 'sequenceFile' | 'requestFile'> | undefined {
  if (/\.seq\.md$/.test(file)) return { sequenceFile: file.replace(/\.md$/, '.ts') }
  if (/\.req\.md$/.test(file)) return { requestFile: file.replace(/\.md$/, '.ts') }
  // `docs` is the flat folder, not an operation named "docs"
  const folder = OP_FOLDER.exec(file)
  if (folder && folder[2] !== 'docs') return { operation: `${folder[1]}/${folder[2]}` }
  const flat = OP_FLAT.exec(file)
  if (flat && !NOT_AN_OPERATION.test(flat[2] as string))
    return { operation: `${flat[1]}/${flat[2]}` }
  return undefined
}

/**
 * Markdown pages that belong to something: by place on disk (see `colocated`), or by naming an
 * `operation:` / `sequence:` (or `page:`) in their frontmatter.
 */
export async function scanDocs(root: string): Promise<DocPage[]> {
  const files = await fg('**/*.md', {
    cwd: root,
    absolute: true,
    ignore: ['**/node_modules/**', '**/.generated/**', '**/dist/**', '**/.git/**'],
  })
  const pages: DocPage[] = []
  const claimed = new Map<string, string>()
  for (const abs of files.sort()) {
    const { meta, body } = frontmatter(await readFile(abs, 'utf8'))
    const file = relative(root, abs).split(sep).join('/')
    const near = colocated(file)
    if (!near && !meta.operation && !meta.sequence && !meta.page) continue
    const operation = meta.operation ?? near?.operation
    if (operation) {
      const first = claimed.get(operation)
      if (first) {
        // two pages for one operation: the first (by path) is used, and the other would be silently ignored
        console.warn(
          `[specbook] ${file} documents ${operation}, which ${first} already does; ignored`,
        )
        continue
      }
      claimed.set(operation, file)
    }
    pages.push({
      file,
      operation,
      sequence: meta.sequence,
      sequenceFile: near?.sequenceFile,
      requestFile: near?.requestFile,
      replace: meta.replace === 'true' || undefined,
      title: meta.title ?? meta.page,
      html: marked.parse(body, { async: false }) as string,
    })
  }
  return pages
}
