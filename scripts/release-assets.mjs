#!/usr/bin/env node
// The files a release carries for teams that host the viewer themselves, or that vet what they install:
// the built viewer as a zip (it runs from any path), and a checksum file for everything in the folder.
//
//   node scripts/release-assets.mjs <version> [--out release-assets]
//
// Needs `pnpm --filter @specbook/ui build:viewer` first, and the `zip` command.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = process.argv[2]?.replace(/^v/, '')
const outFlag = process.argv.indexOf('--out')
const out = resolve(outFlag > -1 ? process.argv[outFlag + 1] : join(root, 'release-assets'))
const viewer = join(root, 'packages/ui/dist-viewer')

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/release-assets.mjs <version> [--out <dir>]')
  process.exit(3)
}
if (!existsSync(join(viewer, 'index.html'))) {
  console.error(
    `the viewer is not built (${viewer}). Run pnpm --filter @specbook/ui build:viewer first.`,
  )
  process.exit(2)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const zip = join(out, `specbook-viewer-${version}.zip`)
// zipped from inside the folder, so index.html sits at the root and the archive unpacks into any directory
const z = spawnSync('zip', ['-qr', zip, '.'], { cwd: viewer, encoding: 'utf8' })
if (z.status !== 0) {
  console.error(`zip failed: ${z.stderr || z.error?.message}`)
  process.exit(1)
}

const sums = readdirSync(out)
  .sort()
  .map(
    (f) =>
      `${createHash('sha256')
        .update(readFileSync(join(out, f)))
        .digest('hex')}  ${f}`,
  )
writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`)
for (const f of readdirSync(out).sort()) console.log(join(out, f))
