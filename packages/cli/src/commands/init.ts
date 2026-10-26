import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureEnvironmentsDir } from '@specbook/vite/internal'
import { agentsStep } from './agents'

/** The faker the CLI itself is tested with. */
const FAKER_VERSION = '9.3.0'

/** The TypeScript the repo itself is checked with; `npx tsc --noEmit` is how a flow's wiring is checked. */
const TYPESCRIPT_VERSION = '7.0.2'

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    lib: ['ES2022', 'DOM'],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    // keeps Node's globals out, so Buffer, process and node: imports fail here and not in the portal
    types: [],
  },
  // `.specbook/*.ts`, not `.specbook`: a bare folder does not pick up specbook.config.ts
  include: ['requests', 'sequences', 'scripts', '.specbook/*.ts', '.generated/*/index.ts'],
}

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
  // generated values in requests and `{{faker.*}}` placeholders in a portal both need it, so it is always there
  pkg.devDependencies = { ...(pkg.devDependencies ?? {}) }
  const hasFaker = ['dependencies', 'devDependencies', 'peerDependencies'].some(
    (k) => pkg[k]?.['@faker-js/faker'],
  )
  if (!hasFaker) pkg.devDependencies['@faker-js/faker'] = FAKER_VERSION
  const hasTypescript = ['dependencies', 'devDependencies', 'peerDependencies'].some(
    (k) => pkg[k]?.typescript,
  )
  if (!hasTypescript) pkg.devDependencies.typescript = TYPESCRIPT_VERSION
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  const added = [
    'a "prepare" script',
    ...(hasFaker ? [] : ['@faker-js/faker']),
    ...(hasTypescript ? [] : ['typescript']),
  ]
  console.log(`✓ added the "#api/*" subpath import, ${added.join(', ')} to package.json`)

  // `npx tsc --noEmit` is the only check a flow's wiring gets, so it needs a config that covers requests and flows
  const tsconfig = join(cwd, 'tsconfig.json')
  if (!existsSync(tsconfig)) {
    await writeFile(tsconfig, `${JSON.stringify(TSCONFIG, null, 2)}\n`)
    console.log('✓ created tsconfig.json (npx tsc --noEmit checks requests, flows and scripts)')
  } else {
    console.log(
      `tsconfig.json already exists and was not changed. For npx tsc --noEmit to check requests, flows and scripts, its "include" needs ${JSON.stringify(TSCONFIG.include)} and "moduleResolution" needs to be "Bundler"`,
    )
  }

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
