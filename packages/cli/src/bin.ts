#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { addCommand } from './commands/add'
import { checkCommand } from './commands/check'
import { ensureGenerated } from './commands/ensure'
import { generateCommand } from './commands/generate'
import { initCommand } from './commands/init'
import { previewCommand } from './commands/preview'
import { runCommand } from './commands/run'
import { secretsCommand } from './commands/secrets'
import { buildCommand, copyViewer, devCommand } from './commands/ui'
import { createLoader } from './load'
import { loadProject } from './project'

const HELP = `specbook <command>

  init                         scaffold config, #api/* import and the environments folder
  add <service> --spec <p>     register an OpenAPI spec in the config and generate it
      --base-url <url>         live base URL to write into the config
  generate [service...]        generate types, operations, examples and metadata from specs
  dev [--port <n>]             start the UI dev server (docs, play panel, credential proxy)
  build [--out <dir>]          build the static docs site and the embeddable specbook.js
      --viewer                 also copy the spec viewer to <out>/viewer/ (open it with ?spec=<url>)
  preview <url|file>           open any OpenAPI/Swagger document in the UI, no project needed
      --port <n> --no-open     port / do not launch the browser
  run <glob...>                run requests / sequences (*.req.ts, *.seq.ts)
      --env <name>             environment (default: mock)
      --param k=v              sequence param / input value (repeatable)
      --var k=v                variable override (repeatable)
      --tag <tag>              only sequences with this tag (repeatable)
      --reporter <r[:path]>    pretty | json | ndjson | junit | github (repeatable)
      --secrets-file <path>    dotenv file with secrets
      --locale <l> --seed <n>  synthetic data locale / deterministic seed
      --notify <url>           POST a summary to a webhook when something fails
  check                        validate specs, generated code drift, placeholders and environment files
  secrets [--env <name>]       show where each declared secret resolves from (never values)
      --secrets-file <path>    include a dotenv file, as run would

Exit codes: 0 pass, 1 failure, 2 run error, 3 usage.`

const parseValue = (v: string): unknown => {
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}
const kv = (list: string[] = []) =>
  Object.fromEntries(
    list.map((s) => {
      const i = s.indexOf('=')
      return [s.slice(0, i), parseValue(s.slice(i + 1))]
    }),
  )

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      env: { type: 'string', default: 'mock' },
      param: { type: 'string', multiple: true },
      var: { type: 'string', multiple: true },
      tag: { type: 'string', multiple: true },
      reporter: { type: 'string', multiple: true },
      'secrets-file': { type: 'string' },
      locale: { type: 'string' },
      seed: { type: 'string' },
      port: { type: 'string' },
      notify: { type: 'string' },
      'base-url': { type: 'string' },
      spec: { type: 'string' },
      out: { type: 'string' },
      'no-open': { type: 'boolean' },
      viewer: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [cmd, ...rest] = positionals
  if (!cmd || values.help) {
    console.log(HELP)
    return cmd ? 0 : 3
  }
  const cwd = process.cwd()
  if (cmd === 'preview') {
    if (!rest[0]) {
      console.error('preview: pass an OpenAPI URL or file\n')
      return 3
    }
    await previewCommand(rest[0], {
      port: values.port ? Number(values.port) : undefined,
      open: !values['no-open'],
    })
    return await new Promise<number>(() => {}) // keep serving until killed
  }
  if (cmd === 'init') {
    await initCommand(cwd)
    return 0
  }
  if (!['generate', 'run', 'dev', 'build', 'add', 'check', 'secrets'].includes(cmd)) {
    console.error(`Unknown command "${cmd}"\n\n${HELP}`)
    return 3
  }
  const loader = await createLoader(cwd)
  try {
    const project = await loadProject(cwd, loader)
    if (cmd === 'generate') {
      await generateCommand(project, loader, rest)
      return 0
    }
    if (cmd === 'add') {
      if (!rest[0] || !values.spec) {
        console.error('usage: specbook add <service> --spec <path> [--base-url <url>]')
        return 3
      }
      await addCommand(project, rest[0], values.spec, values['base-url'])
      return 0
    }
    if (cmd === 'check') return await checkCommand(project, loader)
    // `run`, `dev` and `build` need the generated code; bring missing or stale services up to date
    if (['run', 'dev', 'build'].includes(cmd)) await ensureGenerated(project, loader)
    if (cmd === 'secrets')
      return await secretsCommand(project, values.env as string, values['secrets-file'])
    if (cmd === 'dev') {
      await devCommand(project, values.port ? Number(values.port) : undefined)
      return await new Promise<number>(() => {}) // keep serving until killed
    }
    if (cmd === 'build') {
      await buildCommand(project, values.out ?? 'dist-docs')
      if (values.viewer) {
        const dest = await copyViewer(project, values.out ?? 'dist-docs')
        console.log(`viewer copied to ${dest}`)
      }
      return 0
    }
    if (rest.length === 0) {
      console.error('run: pass at least one file or glob\n')
      return 3
    }
    return await runCommand(project, loader, {
      patterns: rest,
      env: values.env as string,
      params: kv(values.param),
      vars: kv(values.var),
      reporters: values.reporter ?? [],
      secretsFile: values['secrets-file'],
      tags: values.tag ?? [],
      locale: values.locale,
      seed: values.seed ? Number(values.seed) : undefined,
      notify: values.notify,
    })
  } finally {
    await loader.close()
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(2)
  },
)
