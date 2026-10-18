import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureEnvironmentsDir } from '@specbook/vite'
import { agentsStep } from './agents'

export async function initCommand(cwd: string, opts: { agents?: boolean } = {}): Promise<void> {
  const dir = join(cwd, '.specbook')
  await mkdir(dir, { recursive: true })
  const cfg = join(dir, 'specbook.config.ts')
  if (!existsSync(cfg)) {
    await writeFile(
      cfg,
      `import { defineConfig } from '@specbook/core'

export default defineConfig({
  project: 'my-apis',
  // defaults for every environment; an environment overrides them in .specbook/environments/<env>.env
  vars: {
    // petstoreUrl: 'https://petstore3.swagger.io/api/v3',
  },
  services: {
    // petstore: { spec: './openapi/petstore.json', baseUrl: '{{petstoreUrl}}' },
  },
})
`,
    )
    console.log('✓ created .specbook/specbook.config.ts')
  }

  const envDir = await ensureEnvironmentsDir(cwd)
  const example = join(envDir, 'staging.secrets.env.example')
  if (!existsSync(example)) {
    await writeFile(
      example,
      '# Copy to staging.secrets.env (gitignored) and fill in. One KEY=value per line.\n# YOUR_API_KEY=\n',
    )
    await writeFile(
      join(envDir, 'staging.env'),
      '# Non-secret variables for the "staging" environment (committed).\n# region=eu-west-1\n',
    )
    console.log('✓ created .specbook/environments/ (staging.env, staging.secrets.env.example)')
  }

  const pkgPath = join(cwd, 'package.json')
  const pkg = existsSync(pkgPath)
    ? JSON.parse(await readFile(pkgPath, 'utf8'))
    : { name: 'my-apis', private: true, type: 'module' }
  pkg.imports = { ...(pkg.imports ?? {}), '#api/*': './.generated/*/index.ts' }
  // generated code is derived from the specs: regenerate after install instead of committing it
  pkg.scripts = { ...(pkg.scripts ?? {}) }
  if (!pkg.scripts.prepare) pkg.scripts.prepare = 'specbook generate'
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log('✓ added the "#api/*" subpath import and a "prepare" script to package.json')

  const gi = join(cwd, '.gitignore')
  const current = existsSync(gi) ? await readFile(gi, 'utf8') : ''
  const missing = ['.generated', '.specbook/secrets.local.env'].filter(
    (entry) => !current.split('\n').some((l) => l.trim() === entry),
  )
  if (missing.length) {
    await writeFile(
      gi,
      `${current}${current.endsWith('\n') || !current ? '' : '\n'}${missing.join('\n')}\n`,
    )
    console.log(`✓ gitignored ${missing.join(', ')}`)
  }

  await agentsStep(cwd, opts.agents)
}
