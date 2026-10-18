#!/usr/bin/env node
// Packs the five packages the way `npm publish` would, installs the tarballs into an empty project outside the
// workspace, and drives the CLI there. This is what catches a missing `files` entry, a dependency that only
// resolves inside the monorepo, or a TypeScript-only export that breaks in an installed layout.
//
// Needs `pnpm build` and `pnpm --filter @specbook/ui build:viewer` first.
import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const names = ['core', 'codegen', 'vite', 'ui', 'cli']
// the project workflow tooling; everything else is MIT
const SOURCE_AVAILABLE = ['cli', 'vite']
const work = mkdtempSync(join(tmpdir(), 'specbook-pack-'))
const failures = []
const fail = (msg) => {
  failures.push(msg)
  console.error(`✗ ${msg}`)
}
const ok = (msg) => console.log(`✓ ${msg}`)

function run(cmd, args, cwd, label) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, CI: '1' } })
  if (r.status !== 0) {
    fail(`${label} exited ${r.status}\n${r.stdout}${r.stderr}`)
    return undefined
  }
  ok(label)
  return r.stdout + r.stderr
}

try {
  for (const [what, path] of [
    ['the CLI bundle', 'packages/cli/dist/bin.js'],
    ['the vite plugin bundle', 'packages/vite/dist/index.js'],
    ['the built viewer', 'packages/ui/dist-viewer/index.html'],
  ]) {
    if (!existsSync(join(root, path))) {
      console.error(
        `${what} is missing (${path}). Run pnpm build and pnpm --filter @specbook/ui build:viewer.`,
      )
      process.exit(2)
    }
  }

  const packs = join(work, 'packs')
  mkdirSync(packs)
  const tarballs = {}
  for (const n of names) {
    const out = run(
      'pnpm',
      ['pack', '--pack-destination', packs],
      join(root, 'packages', n),
      `pack @specbook/${n}`,
    )
    if (!out) continue
    tarballs[n] = readdirSync(packs).find((f) => f === `specbook-${n}-${readVersion(n)}.tgz`)
  }
  if (failures.length) process.exit(1)

  // the tarballs hold what a user needs and nothing they should not get
  for (const n of names) {
    const list = spawnSync('tar', ['tzf', join(packs, tarballs[n])], { encoding: 'utf8' }).stdout
    if (/\.test\.[cm]?[jt]sx?$/m.test(list)) fail(`@specbook/${n} ships test files`)
    if (!/package\/LICENSE$/m.test(list)) fail(`@specbook/${n} has no LICENSE`)

    // the licence file and the `license` field agree: the project tooling is source-available, the rest MIT
    const read = (file) =>
      spawnSync('tar', ['xOzf', join(packs, tarballs[n]), `package/${file}`], { encoding: 'utf8' })
        .stdout
    const want = SOURCE_AVAILABLE.includes(n) ? 'FSL-1.1-MIT' : 'MIT'
    const declared = JSON.parse(read('package.json')).license
    if (declared !== want) fail(`@specbook/${n} declares license "${declared}", expected "${want}"`)
    const text = read('LICENSE')
    const matches =
      want === 'MIT'
        ? /^MIT License/m.test(text)
        : text.includes('Functional Source License') && text.includes('FSL-1.1-MIT')
    if (!matches) fail(`@specbook/${n} LICENSE text is not ${want}`)
  }
  const uiList = spawnSync('tar', ['tzf', join(packs, tarballs.ui)], { encoding: 'utf8' }).stdout
  for (const need of [
    'package/index.html',
    'package/src/embed.ts',
    'package/dist-viewer/index.html',
    'package/dist-viewer/THIRD-PARTY-NOTICES.txt',
  ])
    if (!uiList.includes(need)) fail(`@specbook/ui is missing ${need}`)

  const proj = join(work, 'project')
  mkdirSync(join(proj, 'openapi'), { recursive: true })
  mkdirSync(join(proj, 'requests'))
  cpSync(join(root, 'apps/example/openapi/petstore.json'), join(proj, 'openapi/petstore.json'))
  const file = (n) => `file:${join(packs, tarballs[n])}`
  writeFileSync(
    join(proj, 'package.json'),
    JSON.stringify(
      {
        name: 'smoke',
        private: true,
        type: 'module',
        devDependencies: { '@specbook/cli': file('cli'), '@specbook/core': file('core') },
        overrides: Object.fromEntries(
          ['core', 'codegen', 'vite', 'ui'].map((n) => [`@specbook/${n}`, file(n)]),
        ),
      },
      null,
      2,
    ),
  )
  if (!run('npm', ['install', '--no-audit', '--no-fund'], proj, 'npm install of the tarballs'))
    process.exit(1)

  const bin = join(proj, 'node_modules/.bin/specbook')
  const sb = (args, label) => run(bin, args, proj, label)
  sb(['init'], 'specbook init')
  // the agent guide ships in the tarball, and init puts it in the project with a pointer in AGENTS.md
  const guide = join(proj, '.specbook/agent-guide.md')
  if (!existsSync(guide))
    fail('specbook init wrote no .specbook/agent-guide.md: is it in the CLI package files?')
  else if (!readFileSync(guide, 'utf8').includes('## Write isomorphic code'))
    fail('the installed agent guide has no isomorphic section')
  else ok('init wrote the agent guide')
  if (!existsSync(join(proj, 'AGENTS.md'))) fail('specbook init created no AGENTS.md')
  sb(
    [
      'add',
      'petstore',
      '--spec',
      './openapi/petstore.json',
      '--base-url',
      'https://petstore3.swagger.io/api/v3',
    ],
    'specbook add',
  )
  sb(['generate'], 'specbook generate')

  writeFileSync(
    join(proj, 'requests/find-pets.req.ts'),
    `import { FindPetsByStatus } from '#api/petstore'

export default FindPetsByStatus.request({
  name: 'Find pets by status',
  query: { status: 'available' },
  assert: (res, { assert }) => assert.is(res.status, 200, 'ok'),
})
`,
  )
  sb(['test', '--env', 'mock'], 'specbook test (mock)')

  sb(['build', '--viewer', '--out', 'dist-docs'], 'specbook build --viewer')
  for (const f of ['dist-docs/index.html', 'dist-docs/specbook.js', 'dist-docs/viewer/index.html'])
    if (!existsSync(join(proj, f))) fail(`build did not write ${f}`)

  // the dev server: it answers, and its dependency scan finds everything (it did not, without a tsconfig)
  const port = await new Promise((res) => {
    const s = createServer().listen(0, () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
  const dev = spawn(bin, ['dev', '--port', String(port)], { cwd: proj, env: process.env })
  let log = ''
  dev.stdout.on('data', (d) => {
    log += d
  })
  dev.stderr.on('data', (d) => {
    log += d
  })
  let status = 0
  for (let i = 0; i < 60 && status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 500))
    status = await fetch(`http://localhost:${port}/`).then(
      (r) => r.status,
      () => 0,
    )
  }
  // the scan runs after the server is listening; give it time to report
  await new Promise((r) => setTimeout(r, 3000))
  // the files the page loads from disk are inside what the server may serve (a package installed beside
  // its hoisted dependencies, as npx does, is where they were refused)
  const refused = []
  if (status === 200) {
    const main = await fetch(`http://localhost:${port}/src/main.tsx`).then((r) => r.text())
    const wanted = new Set(['/@vite/client'])
    for (const m of main.matchAll(/["']([^"']+\.(?:css|svg))["']/g)) wanted.add(m[1])
    for (const path of wanted) {
      const r = await fetch(`http://localhost:${port}${path}`).catch(() => ({ status: 0 }))
      if (r.status !== 200) refused.push(`${path} -> ${r.status}`)
    }
  }
  dev.kill()
  if (refused.length)
    fail(`specbook dev refused files the page loads:\n${refused.join('\n')}\n${log}`)
  if (status !== 200) fail(`specbook dev did not answer\n${log}`)
  else if (/dependency scan|could not be resolved/i.test(log)) fail(`specbook dev warned\n${log}`)
  else ok('specbook dev serves the app with a clean dependency scan')

  // a compiled bundle runs with nothing but node, against a local server
  // the server is a separate process: this one is blocked while a command runs
  const api = spawn(
    process.execPath,
    [
      '-e',
      `require('node:http').createServer((req, res) => {
         res.setHeader('content-type', 'application/json')
         res.end(req.url.startsWith('/pet/findByStatus') ? '[]' : '{}')
       }).listen(0, '127.0.0.1', function () { console.log(this.address().port) })`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const apiPort = await new Promise((resolve) =>
    api.stdout.once('data', (d) => resolve(Number(String(d).trim()))),
  )
  mkdirSync(join(proj, '.specbook/environments'), { recursive: true })
  writeFileSync(
    join(proj, '.specbook/environments/local.env'),
    `petstoreUrl=http://127.0.0.1:${apiPort}\n`,
  )
  try {
    sb(['test', '--env', 'local'], 'specbook test --env local')
    const bundleFile = join(work, 'out', 'specbook-tests.mjs')
    sb(['bundle', '--out', bundleFile], 'specbook bundle')
    // an empty folder with node and nothing else: no node_modules, no spec, no generated code
    const empty = join(work, 'empty')
    mkdirSync(empty, { recursive: true })
    run(process.execPath, [bundleFile, '--env', 'local'], empty, 'the bundle runs with just node')
  } finally {
    api.kill()
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

function readVersion(n) {
  return JSON.parse(
    spawnSync(
      'node',
      ['-p', `JSON.stringify(require('${join(root, 'packages', n, 'package.json')}'))`],
      { encoding: 'utf8' },
    ).stdout,
  ).version
}

if (failures.length) {
  console.error(`\n${failures.length} problem(s) in the packed packages`)
  process.exit(1)
}
console.log('\nthe packed packages install and run')
