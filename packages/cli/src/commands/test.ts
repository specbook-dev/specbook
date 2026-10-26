import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { environmentNames } from '@specbook/core/internal'
import { listEnvironmentFiles, readEnvironment, requestsDirFor } from '@specbook/vite/internal'
import { exampleLoadersFor } from '../examples'
import { projectUsesFaker } from '../faker-use'
import type { Loader } from '../load'
import { unknownOperationsMessage } from '../ops'
import type { Project } from '../project'
import { runTests, type TestCommandOptions } from '../run-tests'
import { discoverTargets, loadFaker, mockLoaderFor } from '../runtime'

export type { TestCommandOptions }

/**
 * Runs the project's requests and flows: finds them in the project's files and hands them to the runner. It never reads a
 * spec; `specbook generate` (which `bin` runs first when the generated code is missing or stale) is what gives it operations.
 */
export async function testCommand(
  project: Project,
  loader: Loader,
  o: TestCommandOptions,
): Promise<number> {
  const unknown = await unknownOperationsMessage(
    project,
    resolve(project.root, project.config.codegen?.outDir ?? '.generated'),
  )
  if (unknown) {
    console.error(unknown)
    return 2
  }
  const patterns = o.patterns.length
    ? o.patterns
    : [
        `${'sequences'}/**/*.seq.ts`,
        `${requestsDirFor(project.root)}/**/*.req.ts`,
        'scripts/**/*.script.ts',
      ]
  const found = await discoverTargets(project, loader, patterns)
  if (found.files.length === 0) {
    console.error(`No files matched: ${patterns.join(', ')}`)
    return 3
  }
  return runTests(
    {
      command: 'specbook test',
      root: project.root,
      config: project.config,
      targets: found.targets,
      environments: environmentNames(project.config, await listEnvironmentFiles(project.root)),
      readEnvironment: (env) => readEnvironment(project.root, env),
      examples: exampleLoadersFor(project),
      mock: mockLoaderFor(project),
      // only a project that uses faker pays for importing it
      loadFaker: async () =>
        (await projectUsesFaker(project.root)) ? loadFaker(project) : undefined,
      readSource: (file) => {
        try {
          return readFileSync(file, 'utf8')
        } catch {
          return undefined
        }
      },
    },
    o,
  )
}
