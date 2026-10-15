#!/usr/bin/env node
// The five published packages always share one version.
//   node scripts/version.mjs            check that they agree (exit 1 if not)
//   node scripts/version.mjs 0.2.0      set them all (a leading "v" is dropped, so a tag works as is)
//   node scripts/version.mjs --expect v0.2.0
//                                       check that they agree and equal that version (the release job)
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const names = ['core', 'codegen', 'vite', 'ui', 'cli']
const files = names.map((n) => join(root, 'packages', n, 'package.json'))
const expect = process.argv[2] === '--expect'
const arg = process.argv[expect ? 3 : 2]?.replace(/^v/, '')

if (arg && !expect) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(arg)) {
    console.error(`"${arg}" is not a version like 1.2.3 or 1.2.3-beta.1`)
    process.exit(3)
  }
  for (const f of files) {
    const pkg = JSON.parse(readFileSync(f, 'utf8'))
    pkg.version = arg
    writeFileSync(f, `${JSON.stringify(pkg, null, 2)}\n`)
  }
  console.log(`set ${names.length} packages to ${arg}`)
} else {
  const found = files.map((f) => {
    const pkg = JSON.parse(readFileSync(f, 'utf8'))
    return [pkg.name, pkg.version]
  })
  const versions = new Set(found.map(([, v]) => v))
  if (expect && (!arg || versions.size !== 1 || !versions.has(arg))) {
    console.error(
      `the release is ${arg ?? '(none)'} but the packages are at ${[...versions].join(', ')}`,
    )
    console.error(
      `run: node scripts/version.mjs ${arg ?? '<version>'}  and commit it before cutting the release`,
    )
    process.exit(1)
  }
  if (versions.size > 1) {
    console.error('packages are not at one version:')
    for (const [n, v] of found) console.error(`  ${n} ${v}`)
    process.exit(1)
  }
  console.log(`all ${names.length} packages at ${[...versions][0]}`)
}
