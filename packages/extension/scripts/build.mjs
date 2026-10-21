// Builds the extension into dist/chromium, and a test variant into dist/chromium-test.
//
// The test variant differs in one way: it already holds host access to loopback addresses and runs its
// relay there. Chrome's own permission prompt cannot be answered by a test, and requesting a permission that
// is already held succeeds without one, so the rest of the flow (the extension's own Allow, the checks, the
// calls) is exercised for real. The shipped manifest asks for nothing up front.

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const out = join(dist, 'chromium')

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const base = JSON.parse(await readFile(join(root, 'manifest.base.json'), 'utf8'))

/** A manifest `version` is up to four dot-separated integers: a prerelease goes in `version_name`. */
function versions(v) {
  const [core, pre] = v.split('-', 2)
  if (!/^\d+\.\d+\.\d+$/.test(core)) throw new Error(`cannot make a manifest version from "${v}"`)
  return pre ? { version: core, version_name: v } : { version: core }
}

await rm(dist, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const common = {
  bundle: true,
  platform: 'browser',
  target: 'chrome116',
  legalComments: 'none',
  logLevel: 'warning',
  outdir: out,
}
await build({ ...common, entryPoints: { sw: 'src/sw.ts' }, format: 'esm' })
// a content script cannot be an ES module
await build({ ...common, entryPoints: { content: 'src/content.ts' }, format: 'iife' })
await build({ ...common, entryPoints: { popup: 'src/popup/popup.ts' }, format: 'iife' })

await cp(join(root, 'src/popup/popup.html'), join(out, 'popup.html'))
await cp(join(root, 'icons'), join(out, 'icons'), { recursive: true })
await cp(join(root, 'LICENSE'), join(out, 'LICENSE'))

const manifest = { ...base, ...versions(pkg.version) }
await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

// the test variant
// loopback, and a name the test suites map to it (a loopback address is itself refused as a private one)
const loopback = [
  'http://127.0.0.1/*',
  'http://localhost/*',
  'http://*.localhost/*',
  'http://*.fixture.test/*',
]
const testOut = join(dist, 'chromium-test')
await cp(out, testOut, { recursive: true })
const test = {
  ...manifest,
  name: `${manifest.name} (test build)`,
  host_permissions: loopback,
  content_scripts: [
    { ...base.content_scripts[0], matches: [...base.content_scripts[0].matches, ...loopback] },
  ],
}
await writeFile(join(testOut, 'manifest.json'), `${JSON.stringify(test, null, 2)}\n`)
console.log(`built ${pkg.name} ${manifest.version} into ${out}`)
