import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve } from 'node:path'

const assemble = resolve(import.meta.dirname, '../../scripts/assemble-site.mjs')

const types: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

/** The site as it is deployed (landing at `/`, the viewer at `/v1/`). Needs `build:viewer` to have run. */
export function assembleSite(out: string): void {
  execFileSync('node', [assemble, '--out', out], { stdio: 'ignore' })
}

/**
 * Serves an assembled site the way the host does: the `_headers` file's policy (CSP, no-referrer, ...) applied
 * to each path, and `specs` answered at `/__specs/<name>.json` for the viewer to open.
 */
export async function siteHandler(dir: string, specs: Record<string, unknown>) {
  // each block names a path pattern, `*` matching anything
  const rules = (await readFile(join(dir, '_headers'), 'utf8'))
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')))
    .filter((lines) => lines.length > 1)
    .map(([path, ...rest]) => ({
      match: new RegExp(
        `^${(path as string)
          .trim()
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')}$`,
      ),
      headers: rest
        .map((l) => l.trim().split(/:\s(.+)/))
        .map((p) => [p[0] as string, p[1] as string] as const),
    }))

  return async (req: IncomingMessage, res: ServerResponse) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname
    const spec = /^\/__specs\/([\w-]+)\.json$/.exec(p)?.[1]
    if (spec && spec in specs) {
      res.setHeader('content-type', 'application/json')
      return void res.end(JSON.stringify(specs[spec]))
    }
    try {
      const f = join(dir, p === '/' ? 'index.html' : p.endsWith('/') ? `${p}index.html` : p)
      res.setHeader('content-type', types[extname(f)] ?? 'application/octet-stream')
      for (const r of rules)
        if (r.match.test(p))
          // `! Name` lets go of a header an earlier rule set, as Pages does
          for (const [k, v] of r.headers)
            if (k.startsWith('!')) res.removeHeader(k.slice(1).trim())
            else res.setHeader(k, v)
      res.end(await readFile(f))
    } catch {
      res.statusCode = 404
      res.end('not found')
    }
  }
}
