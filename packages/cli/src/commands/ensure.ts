import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { generateToDisk } from '@specbook/codegen'
import type { Loader } from '../load'
import type { Project } from '../project'
import { writeMetadata } from './metadata'

const outDirOf = (project: Project) =>
  resolve(project.root, project.config.codegen?.outDir ?? '.generated')

/** Generates the named services (all when none are named) and refreshes `specbook.json`. */
export async function generateServices(
  project: Project,
  loader: Loader,
  only: string[] = [],
  log: (message: string) => void = console.log,
): Promise<string[]> {
  const outDir = outDirOf(project)
  const services = Object.entries(project.config.services).filter(
    ([n]) => only.length === 0 || only.includes(n),
  )
  if (services.length === 0) throw new Error('No matching services in config')
  for (const [name, svc] of services) {
    const spec = resolve(project.root, svc.spec)
    const out = await generateToDisk({ spec, service: name, outDir })
    // output that did not change is not rewritten, so its time would stay older than the spec forever: say it is current
    const now = new Date()
    await utimes(join(out.root, 'manifest.json'), now, now).catch(() => {})
    log(`✓ ${name}: ${out.operations.length} operations → ${out.root}`)
  }
  await writeMetadata(project.root, outDir, loader)
  return services.map(([n]) => n)
}

/** A service is stale when its output is missing or older than its spec or the config. */
function stale(project: Project, name: string): boolean {
  const svc = project.config.services[name]
  const manifest = join(outDirOf(project), name, 'manifest.json')
  // generated before the operations file existed: it has no record of its operations' metadata
  if (!svc || !existsSync(manifest) || !existsSync(join(outDirOf(project), name, 'opmeta.json')))
    return true
  const built = statSync(manifest).mtimeMs
  const spec = resolve(project.root, svc.spec)
  return (
    (existsSync(spec) && statSync(spec).mtimeMs > built) ||
    (existsSync(project.configFile) && statSync(project.configFile).mtimeMs > built)
  )
}

/**
 * Lets projects that do not commit generated code skip `generate`: only missing or stale services are
 * regenerated. Progress goes to stderr so machine-readable output on stdout stays clean.
 */
export async function ensureGenerated(
  project: Project,
  loader: Loader,
  only?: string[],
): Promise<string[]> {
  const names = Object.keys(project.config.services).filter(
    (n) => (!only || only.includes(n)) && stale(project, n),
  )
  if (names.length === 0) return []
  console.error(`Generating ${names.join(', ')} (missing or older than its spec)…`)
  return generateServices(project, loader, names, (m) => console.error(m))
}

/** Whether git tracks this service's generated code, which is what makes drift worth checking. */
export function isTracked(project: Project, service: string): boolean {
  try {
    const manifest = join(outDirOf(project), service, 'manifest.json')
    execFileSync('git', ['ls-files', '--error-unmatch', manifest], {
      cwd: project.root,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}
