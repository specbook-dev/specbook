// The site's /llms.txt: the guide `specbook init` puts in every project (packages/cli/agent-guide.md), then the links an agent may
// want. One source, so the file on the web and the one in a project say the same. Run `pnpm --filter docs llms` after the guide
// changes; a test fails when the committed file is out of date.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const GUIDE = join(here, '../../../packages/cli/agent-guide.md')
export const OUT = join(here, '../public/llms.txt')

const SITE = 'https://docs.specbook.dev'

export const DOCS = [
  ['Develop', `${SITE}/develop/`, 'set up a project, write requests and flows'],
  ['Document', `${SITE}/document/`, 'notes beside operations, "Try it" on any docs page'],
  ['Test', `${SITE}/test/`, 'checks, flows, the QA portal and CI'],
  ['Monitor', `${SITE}/monitor/`, 'production monitoring with the bundle'],
  [
    'AI',
    `${SITE}/ai/`,
    'prompts that make a coding agent write requests and flows, and what it wrote',
  ],
  ['Command line', `${SITE}/reference/cli/`, 'every command and flag'],
  ['Config', `${SITE}/reference/config/`, '`specbook.config.ts` fields'],
  [
    'Authorization',
    `${SITE}/reference/authorization/`,
    'security schemes as profiles, choosing one, sign-in, client credentials, runs and monitors',
  ],
  [
    'Scripts',
    `${SITE}/reference/scripts/`,
    'steps that are code: a browser SDK or a library, with typed inputs and outputs',
  ],
  [
    'Environments and secrets',
    `${SITE}/reference/environments-and-secrets/`,
    'variables per environment, where secrets come from',
  ],
  [
    'Testing and monitoring guide',
    'https://github.com/specbook-dev/specbook/blob/main/docs/testing-and-monitoring.md',
    'the long form, with CI examples',
  ],
]

export const OPTIONAL = [
  ['Embed the viewer and the play panel', `${SITE}/reference/embed/`],
  ['Use with FastAPI', `${SITE}/reference/fastapi/`],
  ['Theming', `${SITE}/reference/theming/`],
  ['Source on GitHub', 'https://github.com/specbook-dev/specbook'],
]

const item = ([name, url, note]) => `- [${name}](${url})${note ? `: ${note}` : ''}`

export function buildLlms(guide) {
  return `${guide.trimEnd()}\n\n## Docs\n\n${DOCS.map(item).join('\n')}\n\n## Optional\n\n${OPTIONAL.map(item).join('\n')}\n`
}

async function main() {
  await writeFile(OUT, buildLlms(await readFile(GUIDE, 'utf8')))
  console.log(`wrote ${OUT}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
