#!/usr/bin/env node
// Assembles the site that `ui.specbook.dev` serves: the landing page at `/`, the viewer build under its
// major channel (`/v1/`), `versions.json`, and the headers file. A Pages deployment replaces the whole
// site, so the release job runs this and deploys the result.
//
//   node scripts/assemble-site.mjs [--out dist-site] [--viewer dist-viewer] [--channel v1] [--status stable]
//                                  [--previous <site url or folder>] [--keep 3]
//
// `--previous` is the site as last deployed. A deployment replaces everything, and a build's hashed files
// have new names each time, so a page loaded from the last build (or one that pinned a file) would 404 on
// its next request. The last few builds' files are carried into this one, and recorded in
// `<channel>/asset-manifest.json` so the next deploy can do the same.
import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : fallback
}
const out = resolve(arg('out', 'dist-site'))
const viewer = resolve(arg('viewer', resolve(root, 'dist-viewer')))
const channel = arg('channel', 'v1')
const status = arg('status', 'stable')
const previous = arg('previous', process.env.SPECBOOK_PREVIOUS_SITE)
const keep = Math.max(1, Number(arg('keep', '3')))

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
await cp(resolve(root, 'landing'), out, { recursive: true })
await cp(viewer, resolve(out, channel), { recursive: true })

// The hosted viewer registers one stable callback address with identity providers (the unversioned page in
// `landing/oauth/callback/`), not its own path, which changes with the channel. The viewer reads this tag;
// builds that do not have it (a self-hosted copy, an embed) use the page's own address. The same goes for the
// landing page: only the hosted viewer has one to send a link to when it cannot read the document's address.
{
  const index = resolve(out, channel, 'index.html')
  const html = await readFile(index, 'utf8')
  const tag =
    '    <meta name="specbook-oauth-callback" content="/oauth/callback/" />\n' +
    '    <meta name="specbook-home" content="/" />\n'
  await writeFile(
    index,
    html.includes('</head>') ? html.replace('</head>', `${tag}  </head>`) : `${tag}${html}`,
  )
}

// What the viewer needs to start, so the landing page can fetch it while the visitor is still typing: the
// app's modules are preloaded, its styles and worker prefetched.
const assets = (await readdir(resolve(out, channel, 'assets'))).sort()
const ahead = {
  modules: assets.filter((f) => f.endsWith('.js') && !/^worker-/.test(f)),
  prefetch: assets.filter((f) => f.endsWith('.css') || /^worker-.*\.js$/.test(f)),
}
const page = resolve(out, 'index.html')
const landing = await readFile(page, 'utf8')
const base = `./${channel}/assets/`
const list = JSON.stringify({
  modules: ahead.modules.map((f) => base + f),
  prefetch: ahead.prefetch.map((f) => base + f),
})
await writeFile(
  page,
  landing.replace(
    '</body>',
    `    <script type="application/json" id="viewer-assets">${list}</script>\n  </body>`,
  ),
)

// ---- version the landing page's own files
// Its stylesheet, script and pictures keep their names from one deploy to the next, and a browser (or the
// CDN in front of the site) may hold them for hours while the page itself is always fresh. A new page with
// an old stylesheet shows a broken layout, so each reference carries a hash of its file: a change is a new
// address, and an unchanged file keeps its cache.
{
  const html = await readFile(page, 'utf8')
  const files = new Set(
    [...html.matchAll(/\b(?:src|href|srcset)="\.\/([^"?#/]+)"/g)].map((m) => m[1]),
  )
  const hashes = new Map()
  for (const f of files) {
    try {
      const body = await readFile(resolve(out, f))
      hashes.set(f, createHash('sha256').update(body).digest('hex').slice(0, 10))
    } catch {
      // a reference to something that is not a file here (a directory, a hash anchor): leave it
    }
  }
  await writeFile(
    page,
    html.replace(/\b(src|href|srcset)="\.\/([^"?#/]+)"/g, (whole, attr, f) =>
      hashes.has(f) ? `${attr}="./${f}?v=${hashes.get(f)}"` : whole,
    ),
  )
}

// ---- carry the last builds' files forward
const read = async (rel) => {
  if (!previous) return undefined
  try {
    if (/^https?:\/\//i.test(previous)) {
      const res = await fetch(`${previous.replace(/\/$/, '')}/${rel}`, {
        signal: AbortSignal.timeout(15000),
      })
      return res.ok ? Buffer.from(await res.arrayBuffer()) : undefined
    }
    return await readFile(resolve(previous, rel))
  } catch {
    return undefined
  }
}
const manifestRel = `${channel}/asset-manifest.json`
let before = []
const prevManifest = await read(manifestRel)
if (prevManifest) {
  try {
    before = JSON.parse(prevManifest.toString('utf8')).builds ?? []
  } catch {
    before = []
  }
} else if (previous) {
  console.warn(`no earlier asset manifest at ${previous}: this is treated as the first build`)
}
const current = { at: new Date().toISOString(), files: assets }
const builds = [...before.filter((b) => b.files?.join() !== assets.join()), current].slice(-keep)
const have = new Set(assets)
let carried = 0
for (const b of builds) {
  for (const f of b.files) {
    if (have.has(f)) continue
    const bytes = await read(`${channel}/assets/${f}`)
    if (!bytes) {
      console.warn(`could not carry ${f} forward from ${previous}`)
      continue
    }
    await writeFile(resolve(out, channel, 'assets', f), bytes)
    have.add(f)
    carried++
  }
}
// what the manifest records is what this deployment really holds
const held = new Set(have)
await writeFile(
  resolve(out, manifestRel),
  `${JSON.stringify({ builds: builds.map((b) => ({ ...b, files: b.files.filter((f) => held.has(f)) })) }, null, 2)}\n`,
)

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
await writeFile(
  resolve(out, 'versions.json'),
  `${JSON.stringify(
    {
      latest: channel,
      versions: [{ channel, path: `/${channel}/`, status, uiVersion: pkg.version }],
    },
    null,
    2,
  )}\n`,
)

// CSP: only this origin's scripts run; the viewer fetches specs and calls APIs, so connect-src is open.
// no-referrer: spec URLs may carry tokens and must not leak in a Referer header.
const policy = (scripts) =>
  [
    "default-src 'self'",
    `script-src ${scripts}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    'connect-src *',
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    'frame-ancestors *',
  ].join('; ')
const csp = policy("'self'")
// Cloudflare Web Analytics may run on the home page only: the viewer's address carries the spec's address (and
// so possibly a token) and the sign-in callback's carries the authorization code, so neither may be measured. Their
// pages also say `no-transform`, which stops Cloudflare adding the beacon to them at all.
const homeCsp = policy("'self' https://static.cloudflareinsights.com")
await writeFile(
  resolve(out, '_headers'),
  `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer

# the home page alone allows the analytics beacon (a rule that sets Content-Security-Policy again is added to the
# one above, so this one first lets go of it)
/
  ! Content-Security-Policy
  Content-Security-Policy: ${homeCsp}

# the sign-in callback page: its script is not hash-versioned, and it is no page to index
/oauth/callback/*
  Cache-Control: no-cache, no-transform
  X-Robots-Tag: noindex

/${channel}/assets/*
  Cache-Control: public, max-age=31536000, immutable
  Access-Control-Allow-Origin: *

# a host page loads this cross-origin, and its worker chunk is started from a blob
/${channel}/specbook.js
  Cache-Control: no-cache
  Access-Control-Allow-Origin: *

/${channel}/
  Cache-Control: no-cache, no-transform

/${channel}/index.html
  Cache-Control: no-cache, no-transform

/${channel}/asset-manifest.json
  Cache-Control: no-cache

/index.html
  Cache-Control: no-cache

/versions.json
  Cache-Control: public, max-age=300
  Access-Control-Allow-Origin: *
`,
)
console.log(`site assembled in ${out} (${channel}, ${status}; ${carried} files carried forward)`)
