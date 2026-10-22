#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { addCommand } from './commands/add'
import { bundleCommand } from './commands/bundle'
import { checkCommand } from './commands/check'
import { ensureGenerated } from './commands/ensure'
import { generateCommand } from './commands/generate'
import { initCommand } from './commands/init'
import { previewCommand } from './commands/preview'
import { secretsCommand } from './commands/secrets'
import { refreshCommand } from './commands/spec-source'
import { testCommand } from './commands/test'
import { buildCommand, copyViewer, devCommand } from './commands/ui'
import { createLoader } from './load'
import { loadProject } from './project'

import { TEST_FLAGS, TEST_HELP, testOptions, UsageError } from './test-args'

const HELP = `specbook <command>

  init                         scaffold config, #api/* import, the environments folder, an agent guide, typescript and a tsconfig
      --agents                 add a Specbook section to an existing AGENTS.md or CLAUDE.md (never edited otherwise)
      --no-agents              skip the agent guide and AGENTS.md
  add <service> --spec <p|url> register an OpenAPI spec in the config and generate it; an address is downloaded to
                               openapi/ and recorded in openapi/sources.json. The spec's security becomes secrets
                               and an auth profile
  add --refresh [service...]   download the recorded addresses again, say what changed and regenerate it
      --base-url <url>         address to use instead of the spec's first server
  generate [service...]        generate types, operations, examples and metadata from specs
  dev [--port <n>]             start the UI dev server (docs, play panel, credential proxy)
  build [--out <dir>]          build the static docs site and the embeddable specbook.js
      --minimal                publish only the operations your requests and flows use (a portal for QA and ops)
      --viewer                 also copy the spec viewer to <out>/viewer/ (open it with ?spec=<url>)
  preview <url|file>           open any OpenAPI/Swagger document in the UI, no project needed
      --port <n> --no-open     port / do not launch the browser
  test [glob...]               run requests and flows against an environment
${TEST_HELP}
  bundle [--out <file>]        compile the tests into one .mjs that runs with just node: for CI or ops, no install
      --tag <t>                only the requests and flows with this tag (repeatable)
      --external <pkg>         leave a package as an import (installed where the file runs; a browser cannot load it; repeatable)
  check                        validate specs, generated code drift, imported operations, placeholders and environment files
  secrets [--env <name>]       show where each declared secret resolves from (never values)
      --secrets-file <path>    include a dotenv file, as test would

Exit codes: 0 pass, 1 a test failed or errored, 2 could not run (secrets, config), 3 usage.`

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      ...TEST_FLAGS,
      port: { type: 'string' },
      'base-url': { type: 'string' },
      spec: { type: 'string' },
      refresh: { type: 'boolean' },
      out: { type: 'string' },
      external: { type: 'string', multiple: true },
      'no-open': { type: 'boolean' },
      agents: { type: 'boolean' },
      'no-agents': { type: 'boolean' },
      viewer: { type: 'boolean' },
      minimal: { type: 'boolean' },
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
    if (values.agents && values['no-agents']) {
      console.error('init: pass --agents or --no-agents, not both\n')
      return 3
    }
    await initCommand(cwd, {
      agents: values['no-agents'] ? false : values.agents ? true : undefined,
    })
    return 0
  }
  if (!['generate', 'test', 'bundle', 'dev', 'build', 'add', 'check', 'secrets'].includes(cmd)) {
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
      if (values.refresh) return await refreshCommand(project, loader, rest)
      if (!rest[0] || !values.spec) {
        console.error(
          'usage: specbook add <service> --spec <path|url> [--base-url <url>]\n       specbook add --refresh [service...]',
        )
        return 3
      }
      await addCommand(project, rest[0], values.spec, values['base-url'])
      return 0
    }
    if (cmd === 'check') return await checkCommand(project, loader)
    // these need the generated code; bring missing or stale services up to date
    if (['dev', 'build', 'test', 'bundle'].includes(cmd)) await ensureGenerated(project, loader)
    if (cmd === 'bundle')
      return await bundleCommand(project, loader, {
        out: values.out ?? 'specbook-tests.mjs',
        tags: values.tag ?? [],
        external: values.external,
      })
    if (cmd === 'secrets')
      return await secretsCommand(project, values.env as string, values['secrets-file'])
    if (cmd === 'dev') {
      await devCommand(project, values.port ? Number(values.port) : undefined)
      return await new Promise<number>(() => {}) // keep serving until killed
    }
    if (cmd === 'build') {
      await buildCommand(project, values.out ?? 'dist-docs', { minimal: values.minimal })
      if (values.viewer) {
        const dest = await copyViewer(project, values.out ?? 'dist-docs')
        console.log(`viewer copied to ${dest}`)
      }
      return 0
    }
    return await testCommand(project, loader, testOptions(values, rest))
  } finally {
    await loader.close()
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(e instanceof UsageError ? 3 : 2)
  },
)
