import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import fg from 'fast-glob'

/** A file uses faker when it imports `@specbook/core/faker` or has a `{{faker.…}}` placeholder. */
export const USES_FAKER = /@specbook\/core\/faker|\{\{\s*faker\./

const IGNORE = [
  '**/node_modules/**',
  '**/.generated/**',
  '**/dist/**',
  '**/.git/**',
  '**/openapi/**',
  '**/*.d.ts',
  '**/package.json',
  '**/package-lock.json',
  '**/tsconfig*.json',
]

/**
 * Whether anything in the project (requests, flows, helpers they import, examples, environment files) uses faker.
 * A run that cannot reach any of it never loads the package.
 */
export async function projectUsesFaker(root: string): Promise<boolean> {
  const files = await fg(['**/*.ts', '**/*.json', '.specbook/**/*.env'], {
    cwd: root,
    ignore: IGNORE,
    dot: true,
    absolute: false,
  })
  for (const f of files)
    if (USES_FAKER.test(await readFile(join(root, f), 'utf8').catch(() => ''))) return true
  return false
}
