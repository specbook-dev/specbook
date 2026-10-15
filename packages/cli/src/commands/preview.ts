import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import SwaggerParser from '@apidevtools/swagger-parser'
import { generateToDisk } from '@specbook/codegen'
import { openApiServers, type SpecbookConfig } from '@specbook/core'
import type { Project } from '../project'
import { authFromSpec } from '../security'
import { devCommand } from './ui'

const isUrl = (s: string) => /^https?:\/\//i.test(s)

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'api'

/** Link a package from this CLI's own dependencies into the temp project so generated code resolves it. */
async function link(root: string, name: string) {
  try {
    // `exports` may hide package.json, so find it by walking up from the resolved entry
    let dir = dirname(createRequire(import.meta.url).resolve(name))
    while (
      !existsSync(join(dir, 'package.json')) ||
      JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name !== name
    )
      dir = dirname(dir)
    const dest = join(root, 'node_modules', ...name.split('/'))
    await mkdir(dirname(dest), { recursive: true })
    await symlink(dir, dest, 'dir')
  } catch {
    /* optional: without faker, dynamic examples still show but placeholders are not filled */
  }
}

function openBrowser(url: string) {
  const [cmd, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url]
  spawn(cmd as string, args, { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref()
}

export interface PreviewOptions {
  port?: number
  open?: boolean
}

/**
 * `specbook preview <url|file>`: a throwaway project around one OpenAPI document, so the full UI runs
 * (docs, examples, mock play, live play through the proxy) with no config and no files left behind.
 */
export async function previewCommand(
  source: string,
  o: PreviewOptions = {},
): Promise<{ url?: string; root: string; close(): Promise<void> }> {
  const local = !isUrl(source)
  const spec = local ? resolve(source) : source
  console.log(`Reading ${source} …`)
  const api = (await SwaggerParser.parse(spec)) as any
  const title = (api.info?.title as string | undefined) ?? 'API'
  const service = slug(title)
  const { servers } = openApiServers(api, source)
  const baseUrl = Object.fromEntries(servers.map((s) => [s.name, s.url]))
  // one server keeps the line it always had; several are listed, so it is clear what the picker offers
  const where =
    servers.length === 0
      ? ''
      : servers.length === 1 && servers[0]?.name === 'live'
        ? `, live calls go to ${servers[0].url}`
        : `\n  Environments: ${servers.map((s) => `${s.name} → ${s.url}`).join(', ')}`

  const root = await mkdtemp(join(tmpdir(), 'specbook-preview-'))
  const cleanup = () => rm(root, { recursive: true, force: true }).catch(() => {})
  process.once('SIGINT', () => cleanup().then(() => process.exit(0)))
  process.once('SIGTERM', () => cleanup().then(() => process.exit(0)))

  let specFile = spec
  if (!local) {
    const res = await fetch(source)
    if (!res.ok) throw new Error(`Could not fetch ${source} (${res.status})`)
    const ext = /ya?ml/.test(extname(new URL(source).pathname)) ? '.yaml' : '.json'
    specFile = join(root, `openapi/api${ext}`)
    await mkdir(dirname(specFile), { recursive: true })
    await writeFile(specFile, await res.text())
  }

  const { auth, secrets, defaultProfile } = authFromSpec(api, source)
  const config = {
    project: service,
    secrets,
    auth,
    services: {
      [service]: {
        spec: specFile,
        baseUrl,
        ...(defaultProfile ? { auth: defaultProfile } : {}),
      },
    },
  } as unknown as SpecbookConfig
  const configFile = join(root, '.specbook/specbook.config.ts')
  await mkdir(dirname(configFile), { recursive: true })
  await writeFile(configFile, `export default ${JSON.stringify(config, null, 2)}\n`)
  await link(root, '@specbook/core')
  await link(root, '@faker-js/faker')

  console.log(`Generating "${title}" …`)
  const out = await generateToDisk({ spec: specFile, service, outDir: join(root, '.generated') })
  console.log(`✓ ${out.operations.length} operations${where}`)

  const project: Project = { root, configFile, config }
  const server = await devCommand(project, o.port ?? 5173)
  const url = server.resolvedUrls?.local[0]
  if (url && o.open !== false) openBrowser(url)
  console.log('\nPreview only: nothing is written to your project. Ctrl+C to stop.')
  return {
    url,
    root,
    close: async () => {
      await server.close()
      await cleanup()
    },
  }
}
