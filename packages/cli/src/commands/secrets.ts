import { resolve } from 'node:path'
import type { SecretProvider } from '@specbook/core'
import { readEnvironment } from '@specbook/vite'
import { type Project, readDotenv } from '../project'

/**
 * `specbook secrets --env staging`: every declared secret and where it resolves from. Values are never
 * printed. Exit 1 when something is missing, so CI can gate on it.
 */
export async function secretsCommand(
  project: Project,
  env: string,
  secretsFile?: string,
): Promise<number> {
  const declared = project.config.secrets ?? {}
  const names = Object.keys(declared)
  if (names.length === 0) {
    console.log('No secrets declared in the config (`secrets: { NAME: {} }`).')
    return 0
  }
  const files = await readEnvironment(project.root, env)
  const layers: { where: string; get: (key: string) => string | undefined }[] = [
    { where: 'environment variable', get: (k) => process.env[k] },
    ...(secretsFile
      ? [
          {
            where: `--secrets-file`,
            get: (
              (vals: Record<string, string>) => (k: string) =>
                vals[k]
            )(await readDotenv(resolve(secretsFile))),
          },
        ]
      : []),
    { where: `environments/${env}.secrets.env`, get: (k) => files.secrets[k] },
    { where: 'secrets.local.env (shared)', get: (k) => files.shared[k] },
  ]
  const custom: SecretProvider[] = project.config.secretProviders ?? []

  let missing = 0
  const width = Math.max(...names.map((n) => n.length))
  console.log(`Secrets for "${env}":`)
  for (const name of names) {
    const key = declared[name]?.env ?? name
    let where = layers.find((l) => l.get(key) !== undefined)?.where
    if (!where)
      for (const p of custom) {
        if ((await p.resolve(declared[name] ?? {}, name)) !== undefined) {
          where = `provider "${p.name}"`
          break
        }
      }
    if (!where) missing++
    console.log(
      `  ${where ? '✓' : '✗'} ${name.padEnd(width)}  ${where ?? `missing (set ${key})`}${key !== name ? `  [env var ${key}]` : ''}`,
    )
  }
  if (missing)
    console.log(`\n${missing} missing. Add them to .specbook/environments/${env}.secrets.env`)
  return missing ? 1 : 0
}
