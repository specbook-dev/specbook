import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { projectUsesFaker } from '../src/faker-use'

let dir: string
afterEach(() => rm(dir, { recursive: true, force: true }))

async function project(files: Record<string, string>) {
  dir = await mkdtemp(join(tmpdir(), 'sb-use-'))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), text)
  }
  return dir
}

describe('whether a project uses faker', () => {
  it('is false for a project with a faker config section but no use', async () => {
    const root = await project({
      '.specbook/specbook.config.ts': "export default { faker: { default: 'en' } }\n",
      'requests/a.req.ts': 'export default {}\n',
    })
    expect(await projectUsesFaker(root)).toBe(false)
  })

  it.each([
    [
      'an import in a request',
      { 'requests/a.req.ts': "import { faker } from '@specbook/core/faker'\n" },
    ],
    ['a helper', { 'lib/names.ts': "import { faker } from '@specbook/core/faker'\n" }],
    [
      'a placeholder in an example',
      { 'requests/svc/Op/a.example.json': '{"body":{"n":"{{faker.person.firstName}}"}}' },
    ],
    [
      'an environment file',
      { '.specbook/environments/dev.env': 'who={{faker.person.firstName}}\n' },
    ],
  ])('is true for %s', async (_name, files) => {
    expect(await projectUsesFaker(await project(files))).toBe(true)
  })

  it('does not read installed packages or the generated code', async () => {
    const root = await project({
      'node_modules/x/index.ts': "import '@specbook/core/faker'\n",
      '.generated/svc/a.ts': '{{faker.x.y}}\n',
    })
    expect(await projectUsesFaker(root)).toBe(false)
  })
})
