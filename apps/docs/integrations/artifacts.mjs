// The site is the demo, so the demos are built from this repository and copied into it: the full example build at /demo/,
// the QA portal (the demo project's minimal build, which also carries the play panel's `specbook.js`) at /qa/, the viewer
// at /viewer/ and the service worker that is the demo API at /sw.js. It also
// writes the headers: a policy that allows exactly the scripts the build produced, found by reading them back.

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const docs = resolve(here, '..')
const repo = resolve(docs, '../..')

/** What is copied, where from and to, and the command that builds it. */
export const ARTIFACTS = [
  {
    from: join(repo, 'apps/example/dist-docs'),
    to: 'demo',
    build: 'pnpm --filter example build:docs',
  },
  { from: join(docs, 'demo/dist-qa'), to: 'qa', build: 'pnpm --filter docs-demo build:qa' },
  {
    from: join(repo, 'packages/ui/dist-viewer'),
    to: 'viewer',
    build: 'pnpm --filter @specbook/ui build:viewer',
  },
  {
    from: join(docs, 'demo/dist-sw/sw.js'),
    to: 'sw.js',
    build: 'pnpm --filter docs-demo build:sw',
    file: true,
  },
  {
    from: join(docs, 'demo/openapi/petstore.json'),
    to: 'specs/petstore.json',
    build: '',
    file: true,
  },
]

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.sha256': 'text/plain; charset=utf-8',
}

function missing() {
  return ARTIFACTS.filter((a) => !existsSync(a.from))
}

async function htmlFiles(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await htmlFiles(p)))
    else if (e.name.endsWith('.html')) out.push(p)
  }
  return out
}

/** `'sha256-…'` for the body of every inline script in a page, which is what a policy without 'unsafe-inline' allows. */
export function inlineScriptHashes(html) {
  const hashes = new Set()
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\bsrc\s*=/.test(m[1]) || !m[2].trim()) continue
    hashes.add(`'sha256-${createHash('sha256').update(m[2]).digest('base64')}'`)
  }
  return [...hashes]
}

/** The same for `<style>` elements: Astro writes one small rule for its islands into every page that has one. */
export function inlineStyleHashes(html) {
  const hashes = new Set()
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
    if (!m[1].trim()) continue
    hashes.add(`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`)
  }
  return [...hashes]
}

/** Cloudflare Web Analytics: the beacon Pages adds to a page once it is turned on for the project, and where it reports to. */
const ANALYTICS_SCRIPT = 'https://static.cloudflareinsights.com'
const ANALYTICS_REPORT = 'https://cloudflareinsights.com'

/** Cloudflare Turnstile: the script that draws the widget, and the frame it draws in. */
const TURNSTILE = 'https://challenges.cloudflare.com'

/**
 * The `_headers` file: one strict policy for the pages, a looser one for the copied apps that call other origins.
 * Every one of them may load Cloudflare's Turnstile widget (its script and its frame), except the viewer, which runs no
 * project code and so can never show one.
 */
export function headersFile(scriptHashes, styleHashes = []) {
  const base = (widget) => [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(' ')} ${ANALYTICS_SCRIPT} ${widget ? TURNSTILE : ''}`
      .replace(/ +/g, ' ')
      .trim(),
    `style-src 'self' ${styleHashes.join(' ')}`.trim(),
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "worker-src 'self' blob:",
    `frame-src 'self' ${widget ? TURNSTILE : ''}`.trim(),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ]
  // the landing page runs its example against the public Petstore, which answers any origin
  const policy = [
    ...base(true),
    `connect-src 'self' https://petstore3.swagger.io ${ANALYTICS_REPORT}`,
  ].join('; ')
  // the viewer opens any address a visitor gives it, and the demo and QA portal can run against a real API
  // and they are the apps' own pages, which the viewer's production policy lets set inline styles
  const open = (widget) =>
    [
      ...base(widget).filter((d) => !d.startsWith('style-src')),
      "style-src 'self' 'unsafe-inline'",
      'connect-src *',
    ].join('; ')
  const common = [
    'X-Content-Type-Options: nosniff',
    'Referrer-Policy: strict-origin-when-cross-origin',
    'Permissions-Policy: camera=(), microphone=(), geolocation=()',
  ]
  const rule = (path, lines) => `${path}\n${lines.map((l) => `  ${l}`).join('\n')}\n`
  return [
    rule('/*', [`Content-Security-Policy: ${policy}`, ...common]),
    rule('/viewer/*', ['! Content-Security-Policy', `Content-Security-Policy: ${open(false)}`]),
    ...['/demo/*', '/qa/*'].map((p) =>
      rule(p, ['! Content-Security-Policy', `Content-Security-Policy: ${open(true)}`]),
    ),
    rule('/', ['Cache-Control: no-cache']),
    rule('/*.html', ['Cache-Control: no-cache']),
    rule('/_astro/*', ['Cache-Control: public, max-age=31536000, immutable']),
    rule('/demo/assets/*', ['Cache-Control: public, max-age=31536000, immutable']),
    rule('/qa/assets/*', ['Cache-Control: public, max-age=31536000, immutable']),
    rule('/viewer/assets/*', ['Cache-Control: public, max-age=31536000, immutable']),
    // the entry scripts are not hashed, so they are fetched fresh and they name the hashed files
    rule('/qa/specbook.js', ['Cache-Control: no-cache']),
    rule('/demo/specbook.js', ['Cache-Control: no-cache']),
    rule('/sw.js', ['Cache-Control: no-cache', 'Content-Type: text/javascript; charset=utf-8']),
    rule('/pagefind/*', ['Cache-Control: public, max-age=3600']),
    rule('/llms.txt', [
      'Content-Type: text/plain; charset=utf-8',
      'Cache-Control: public, max-age=3600',
    ]),
  ].join('\n')
}

/** Pages that moved, so a link to the old place still lands. */
export const REDIRECTS = '/testing-and-monitoring /test/ 301\n/discover / 301\n'

export function artifacts() {
  return {
    name: 'specbook-artifacts',
    hooks: {
      'astro:config:setup': ({ command }) => {
        if (command !== 'build') return
        const lacking = missing()
        if (lacking.length)
          throw new Error(
            `The site needs builds that are not there yet:\n${lacking
              .map(
                (a) => `  ${a.from.replace(`${repo}${sep}`, '')}  (${a.build || 'a source file'})`,
              )
              .join('\n')}\nRun "pnpm build:site" at the repository root, which builds them first.`,
          )
      },
      'astro:server:setup': ({ server }) => {
        // in development the same folders answer where they will be in the site
        server.middlewares.use((req, res, next) => {
          const path = decodeURIComponent((req.url ?? '/').split('?')[0])
          for (const a of ARTIFACTS) {
            const mount = `/${a.to}`
            const inside = a.file ? path === mount : path === mount || path.startsWith(`${mount}/`)
            if (!inside) continue
            let file = a.file ? a.from : join(a.from, normalize(path.slice(mount.length)))
            if (!a.file && !file.startsWith(a.from)) return next()
            if (!a.file && existsSync(file) && statSync(file).isDirectory())
              file = join(file, 'index.html')
            if (!existsSync(file) || !statSync(file).isFile()) return next()
            res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream')
            res.setHeader('cache-control', 'no-cache')
            createReadStream(file).pipe(res)
            return
          }
          next()
        })
      },
      'astro:build:done': async ({ dir }) => {
        const out = fileURLToPath(dir)
        for (const a of ARTIFACTS) {
          const to = join(out, a.to)
          await mkdir(a.file ? dirname(to) : to, { recursive: true })
          await cp(a.from, to, { recursive: true })
        }
        const hashes = new Set()
        const styles = new Set()
        for (const f of await htmlFiles(out)) {
          // the copied apps have their own pages and their own policy
          if (/[\\/](demo|qa|viewer)[\\/]/.test(f.slice(out.length))) continue
          const html = await readFile(f, 'utf8')
          for (const h of inlineScriptHashes(html)) hashes.add(h)
          for (const h of inlineStyleHashes(html)) styles.add(h)
        }
        await writeFile(join(out, '_headers'), headersFile([...hashes], [...styles]))
        await writeFile(join(out, '_redirects'), REDIRECTS)
      },
    },
  }
}
