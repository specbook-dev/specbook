import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { generate } from '@specbook/codegen'
import { collectPlaceholders } from '@specbook/core'
import { listEnvironmentFiles, readEnvironment } from '@specbook/vite'
import fg from 'fast-glob'
import type { Loader } from '../load'
import type { Project } from '../project'
import { ensureGenerated, isTracked } from './ensure'

/** Validates specs, generated-code drift and placeholder/secret references. Exit 1 on errors. */
export async function checkCommand(project: Project, loader: Loader): Promise<number> {
  const errors: string[] = []
  const warnings: string[] = []
  const cfg = project.config
  const outDir = resolve(project.root, cfg.codegen?.outDir ?? '.generated')

  // Drift only means something when the generated code is committed. Otherwise it is local, derived
  // output: bring it up to date and move on, so a stale copy never fails the check.
  const untracked = Object.keys(cfg.services).filter((n) => !isTracked(project, n))
  if (untracked.length) await ensureGenerated(project, loader, untracked)

  for (const [name, svc] of Object.entries(cfg.services)) {
    const spec = resolve(project.root, svc.spec)
    if (!existsSync(spec)) {
      errors.push(`[${name}] spec not found: ${svc.spec}`)
      continue
    }
    try {
      const { files } = await generate({ spec, service: name })
      if (untracked.includes(name)) continue
      let drift = 0
      for (const f of files) {
        const p = join(outDir, name, f.path)
        if (!existsSync(p) || (await readFile(p, 'utf8')) !== f.content) drift++
      }
      if (drift)
        errors.push(
          `[${name}] generated code is out of date (${drift} files differ): run "specbook generate"`,
        )
    } catch (e) {
      errors.push(`[${name}] invalid spec: ${e instanceof Error ? e.message : e}`)
    }
  }

  // environment files: a declared secret in a committed `<env>.env` is a leak waiting to happen
  const knownEnvs = new Set<string>([
    'mock',
    ...Object.keys(cfg.environments ?? {}),
    ...Object.values(cfg.services).flatMap((s) => Object.keys(s.baseUrl ?? {})),
  ])
  const secretKeys = new Set(
    Object.entries(cfg.secrets ?? {}).map(([name, ref]) => ref.env ?? name),
  )
  for (const env of await listEnvironmentFiles(project.root)) {
    if (!knownEnvs.has(env))
      warnings.push(
        `[.specbook/environments/${env}.*] no service has a "${env}" baseUrl, so this environment is never used`,
      )
    const values = await readEnvironment(project.root, env)
    for (const key of Object.keys(values.vars))
      if (secretKeys.has(key))
        errors.push(
          `[.specbook/environments/${env}.env] "${key}" is a declared secret but sits in a committed file; move it to ${env}.secrets.env`,
        )
  }

  const known = new Set<string>([
    ...Object.keys(cfg.vars ?? {}),
    ...Object.values(cfg.environments ?? {}).flatMap((e) => Object.keys(e?.vars ?? {})),
  ])
  const declared = new Set(Object.keys(cfg.secrets ?? {}))
  const files = await fg('**/*.req.ts', {
    cwd: project.root,
    absolute: true,
    ignore: ['**/node_modules/**', '**/.generated/**'],
  })
  for (const file of files.sort()) {
    const rel = file.slice(project.root.length + 1)
    let mod: Record<string, any>
    try {
      mod = await loader.import(file)
    } catch (e) {
      errors.push(`[${rel}] failed to load: ${e instanceof Error ? e.message : e}`)
      continue
    }
    const def = mod.default
    if (def?.kind !== 'request') continue
    let data: unknown = def.input.data
    if (typeof data === 'function')
      data = (await (data as () => Promise<{ default: unknown }>)()).default
    const used = collectPlaceholders([
      def.input.headers,
      def.input.path,
      def.input.query,
      data,
      ...def.dataPatches,
    ])
    const init = new Set(Object.keys(def.input.init ?? {}))
    const roots = new Set([...used].map((n) => n.split('.')[0] as string))
    for (const name of used) {
      const root = name.split('.')[0] as string
      if (name.startsWith('secrets.')) {
        if (!declared.has(name.slice(8)))
          warnings.push(`[${rel}] secret "${name.slice(8)}" is not declared in config.secrets`)
      } else if (name.startsWith('session.') || name.startsWith('faker.')) {
      } else if (!init.has(root) && !known.has(root)) {
        warnings.push(
          `[${rel}] "{{${name}}}" has no init value or config var, so it must come from a capture or sequence param`,
        )
      }
    }
    for (const key of Object.keys(def.input.capture ?? {})) {
      if (init.has(key) || roots.has(key))
        warnings.push(
          `[${rel}] captures "${key}" which this request also sends; "vars.${key}" in its assert is the captured value, so checks against it prove nothing`,
        )
    }
    if (init.has('faker'))
      warnings.push(`[${rel}] "faker" is reserved for {{faker.*}}; rename this var`)
  }

  for (const w of warnings) console.log(`⚠ ${w}`)
  for (const e of errors) console.log(`✗ ${e}`)
  if (!errors.length && !warnings.length) console.log('✓ no problems found')
  else console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)`)
  return errors.length ? 1 : 0
}
