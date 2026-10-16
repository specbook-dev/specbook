// The entry of a compiled test bundle (`specbook bundle`): the requests and flows are already loaded, so this only turns
// the command line into a run. It must stay free of the Vite loader, the globber and the spec tooling.

import { File } from 'node:buffer'
import { basename, posix } from 'node:path'
import { parseArgs } from 'node:util'
import {
  type Example,
  type ExampleLoader,
  environmentNames,
  type FileReader,
  type SpecbookConfig,
} from '@specbook/core'
import { runTests, type Target, targetsOf } from './run-tests'
import { TEST_FLAGS, TEST_HELP, testOptions, UsageError } from './test-args'
import { fixCliVersion } from './version'

/** What `specbook bundle` compiles into a bundle next to the code. */
export interface StandaloneData {
  specbook: string
  createdAt: string
  git?: { sha?: string; branch?: string }
  config: SpecbookConfig
  /** the request and flow modules, by project-relative file */
  modules: { file: string; mod: Record<string, unknown> }[]
  /** non-secret variables of each environment file */
  environments: Record<string, Record<string, string>>
  /** `service/Operation/name` → the example document and where it came from */
  examples: Record<string, { doc: Example; source: 'project' | 'generated'; dir: string }>
  /** project-relative path → base64: the files requests upload */
  files: Record<string, string>
  /** faker with just the locales the project uses, when it uses faker */
  faker?: Record<string, unknown>
}

const HELP = (name: string) => `${name} [options]   run the tests built into this file

${TEST_HELP}
  --help                       this text

Exit codes: 0 pass, 1 a test failed or errored, 2 could not run (secrets, config), 3 usage.
There is no mock environment here: name a real one with --env. Secrets come from environment variables.`

export async function main(data: StandaloneData, argv = process.argv.slice(2)): Promise<number> {
  fixCliVersion(data.specbook)
  const name = `node ${basename(process.argv[1] ?? 'tests.mjs')}`
  const options = { ...TEST_FLAGS, help: { type: 'boolean', short: 'h' } } as const
  const parse = () => parseArgs({ args: argv, options, allowPositionals: true })
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse()
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : e}\n\n${HELP(name)}`)
    return 3
  }
  if (parsed.values.help) {
    console.log(HELP(name))
    return 0
  }
  let o: ReturnType<typeof testOptions>
  try {
    o = testOptions(parsed.values, parsed.positionals)
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    console.error(e.message)
    return 3
  }
  const environments = environmentNames(data.config, Object.keys(data.environments))
  const targets: Target[] = data.modules.flatMap((m) => targetsOf(m.mod, m.file))

  const example: ExampleLoader = async (op, exampleName) => {
    const hit = data.examples[`${op.service}/${op.id}/${exampleName}`]
    return hit ? { ...hit.doc, source: hit.source, dir: hit.dir } : undefined
  }
  const readFile: FileReader = async (path, dir) => {
    const key = posix.normalize(posix.join(dir ?? '', path))
    const b64 = data.files[key]
    if (b64 === undefined) throw new Error(`File "${key}" is not in this bundle`)
    return new File([Buffer.from(b64, 'base64')], posix.basename(key)) as unknown as globalThis.File
  }

  return runTests(
    {
      command: name,
      root: process.cwd(),
      config: data.config,
      targets,
      environments,
      readEnvironment: async (env) => ({
        vars: data.environments[env] ?? {},
        secrets: {},
        shared: {},
      }),
      examples: { example, readFile },
      loadFaker: async () => data.faker,
      bundle: { sha: data.git?.sha, createdAt: data.createdAt },
      git: {},
      readSource: () => undefined,
      hideLocations: true,
      secretFiles: false,
    },
    o,
  )
}
