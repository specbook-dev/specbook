// Records what the real CLI prints, with its colors and its timing, so the docs site can replay it: `captures/<name>.json`.
// The demo API runs on a port of this machine, the CLI is the built one, and a recording whose exit code is not the one
// expected fails the script, so a page can never show output the tool no longer produces.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(fileURLToPath(import.meta.url), '../..')
const cli = resolve(root, '../../../packages/cli/dist/bin.js')
const out = join(root, 'captures')
const SITE = 'https://docs.specbook.dev'

// the demo API, as the service worker serves it, on a port here
const work = await mkdtemp(join(tmpdir(), 'sb-capture-'))
await build({
  entryPoints: [join(root, 'server/node.ts')],
  outfile: join(work, 'node.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  conditions: ['import'],
  logLevel: 'warning',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url)",
  },
})
const demo = await (await import(pathToFileURL(join(work, 'node.mjs')))).start(0)
const chaos = (patch) =>
  fetch(`${demo.origin}/api/_demo/chaos`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
const reset = () => fetch(`${demo.origin}/api/_demo/reset`, { method: 'POST' })

/** What a page must not show: this machine's paths and port. */
const mask = (text, dirs, site) => {
  let t = text.replaceAll(demo.origin, site)
  for (const [from, to] of dirs) t = t.replaceAll(from, to)
  // the branch and commit of whoever recorded it
  return t.replace(/[\w./-]+@[0-9a-f]{7}/g, 'main@3f9c2ab')
}

function record({ name, command, args, cwd, expect, home = cwd, env = {}, site = SITE }) {
  return new Promise((done, fail) => {
    const started = Date.now()
    const chunks = []
    const child = spawn(process.execPath, args, {
      cwd,
      env: {
        ...process.env,
        FORCE_COLOR: '1',
        NO_COLOR: undefined,
        GITHUB_ACTIONS: '',
        CI: '',
        ...env,
      },
    })
    const take = (d) => chunks.push({ t: Date.now() - started, data: d.toString('utf8') })
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', fail)
    child.on('close', async (code) => {
      if (code !== expect)
        return fail(
          new Error(
            `${name}: exit ${code}, expected ${expect}\n${chunks.map((c) => c.data).join('')}`,
          ),
        )
      const dirs = [
        [home, '~/my-api'],
        [root, '~/my-api'],
        [work, '~'],
      ]
      const masked = chunks.map((c) => ({ t: c.t, data: mask(c.data, dirs, site) }))
      await writeFile(
        join(out, `${name}.json`),
        `${JSON.stringify({ name, command, exit: code, chunks: masked })}\n`,
      )
      console.log(`${name}: exit ${code}, ${chunks.length} chunks, ${Date.now() - started}ms`)
      done()
    })
  })
}

const vars = [
  '--var',
  `petstoreUrl=${demo.origin}/api/petstore`,
  '--var',
  `countriesUrl=${demo.origin}/api/countries`,
]
const test = (name, command, extra, expect, patch = {}) => ({
  name,
  command,
  args: [cli, 'test', '--env', 'demo', ...extra, ...vars],
  cwd: root,
  expect,
  patch,
})

try {
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })

  const runs = [
    test('test-pass', 'specbook test --env demo', [], 0),
    test('test-fail', 'specbook test --env demo', [], 1, { mutate: true }),
    test('test-flaky', 'specbook test --env demo --retries 1', ['--retries', '1'], 0, {
      failNext: 1,
    }),
    test('test-down', 'specbook test --env demo', [], 1, { fail: true }),
  ]
  for (const { patch, ...r } of runs) {
    await reset()
    await chaos(patch)
    await record(r)
  }
  await reset()

  // the bundle: one file, only node
  await record({
    name: 'bundle-run',
    // run where an ops team would: against an address of their own, here the demo API on this machine
    command:
      'node specbook-tests.mjs --env demo --var petstoreUrl=$STAGING/api/petstore --var countriesUrl=$STAGING/api/countries',
    args: [join(root, 'dist-bundle/specbook-tests.mjs'), '--env', 'demo', ...vars],
    cwd: join(root, 'dist-bundle'),
    expect: 0,
    site: 'https://staging.example.com',
  })

  // a new project, from nothing
  const project = join(work, 'my-api')
  await mkdir(project, { recursive: true })
  await writeFile(
    join(project, 'package.json'),
    '{"name":"my-api","private":true,"type":"module"}\n',
  )
  // what `npm install @specbook/core @specbook/cli` would have put there
  await mkdir(join(project, 'node_modules/@specbook'), { recursive: true })
  for (const pkg of ['core', 'cli'])
    await symlink(
      resolve(root, `../../../packages/${pkg}`),
      join(project, `node_modules/@specbook/${pkg}`),
    )
  const spec = join(root, 'openapi/petstore.json')
  const setup = [
    ['init', 'specbook init', [cli, 'init']],
    [
      'add',
      'specbook add petstore --spec ./openapi/petstore.json',
      [cli, 'add', 'petstore', '--spec', './openapi/petstore.json'],
    ],
    ['generate', 'specbook generate', [cli, 'generate']],
  ]
  await mkdir(join(project, 'openapi'), { recursive: true })
  await writeFile(join(project, 'openapi/petstore.json'), await readFile(spec))
  for (const [name, command, args] of setup)
    await record({ name: `develop-${name}`, command, args, cwd: project, expect: 0 })
} finally {
  await demo.close()
  await rm(work, { recursive: true, force: true })
}
