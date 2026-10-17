// Where a project's OpenAPI documents came from: downloaded by `specbook add <service> --spec <url>`, recorded in
// `openapi/sources.json` so `specbook add --refresh` can fetch them again and say what changed.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import SwaggerParser from '@apidevtools/swagger-parser'
import type { Loader } from '../load'
import type { Project } from '../project'
import { generateServices } from './ensure'

/** `26 KB`, `8.3 MB`: what a person reads, not `0.0 MB` for a small document. */
export const sizeOf = (bytes: number) =>
  bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`

export const SOURCES_FILE = 'sources.json'

/** What a downloaded document is recorded as: enough to fetch it again and to see that it changed. */
export interface SourceEntry {
  url: string
  sha256: string
  bytes: number
}

export type Sources = Record<string, SourceEntry>

export const isUrl = (s: string) => /^https?:\/\//i.test(s)

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

export async function readSources(dir: string): Promise<Sources> {
  try {
    return JSON.parse(await readFile(join(dir, SOURCES_FILE), 'utf8')) as Sources
  } catch {
    return {}
  }
}

async function writeSources(dir: string, sources: Sources): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, SOURCES_FILE), `${JSON.stringify(sorted, null, 2)}\n`)
}

/** `.json` for JSON, else the address's own `.yaml`/`.yml`, else `.yaml`. */
function extensionFor(url: string, body: Buffer): string {
  try {
    JSON.parse(body.toString('utf8'))
    return '.json'
  } catch {
    const m = /\.(ya?ml)$/i.exec(new URL(url).pathname)
    return m ? `.${m[1]?.toLowerCase()}` : '.yaml'
  }
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) }).catch((e: unknown) => {
    throw new Error(`Could not download ${url}: ${e instanceof Error ? e.message : e}`)
  })
  if (!res.ok) throw new Error(`Could not download ${url}: ${res.status} ${res.statusText}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Refuses anything that is not an OpenAPI or Swagger document, before it is kept. */
async function validate(file: string): Promise<void> {
  try {
    const api = (await SwaggerParser.parse(file)) as { openapi?: string; swagger?: string }
    if (!api.openapi && !api.swagger) throw new Error('it has no "openapi" or "swagger" version')
  } catch (e) {
    throw new Error(
      `${basename(file)} is not an OpenAPI document: ${e instanceof Error ? e.message : e}`,
    )
  }
}

/**
 * Downloads a document into `openapi/<service>.<ext>` and records where it came from. An existing file of that name is
 * left alone unless it is the same document.
 */
export async function fetchSpec(
  project: Project,
  service: string,
  url: string,
): Promise<{ file: string; entry: SourceEntry }> {
  const body = await download(url)
  const dir = resolve(project.root, 'openapi')
  const file = join(dir, `${service}${extensionFor(url, body)}`)
  if (existsSync(file) && sha256(await readFile(file)) !== sha256(body))
    throw new Error(
      `${relative(project.root, file)} already exists and differs: use another service name, or "specbook add --refresh ${service}" to update it`,
    )
  await mkdir(dir, { recursive: true })
  await writeFile(file, body)
  try {
    await validate(file)
  } catch (e) {
    await rm(file, { force: true })
    throw e
  }
  const entry = { url, sha256: sha256(body), bytes: body.length }
  const sources = await readSources(dir)
  sources[basename(file)] = entry
  await writeSources(dir, sources)
  return { file, entry }
}

const short = (hash: string) => hash.slice(0, 12)

/**
 * `specbook add --refresh [service...]`: downloads again every service whose document has a recorded source, says which
 * ones changed, and regenerates those. A service added from a file has no source and is left as it is.
 */
export async function refreshCommand(
  project: Project,
  loader: Loader,
  only: string[],
): Promise<number> {
  const unknown = only.filter((n) => !project.config.services[n])
  if (unknown.length) {
    console.error(`Not services of this project: ${unknown.join(', ')}`)
    return 3
  }
  const names = Object.keys(project.config.services).filter((n) => !only.length || only.includes(n))
  const changed: string[] = []
  let failed = 0
  for (const name of names) {
    const file = resolve(project.root, project.config.services[name]?.spec ?? '')
    const entry = (await readSources(dirname(file)))[basename(file)]
    if (!entry) {
      console.log(`  ${name}: no recorded source (added from a file), left as it is`)
      continue
    }
    try {
      const body = await download(entry.url)
      if (sha256(body) === entry.sha256) {
        console.log(`✓ ${name}: unchanged (sha256 ${short(entry.sha256)})`)
        continue
      }
      const previous = await readFile(file).catch(() => undefined)
      await writeFile(file, body)
      try {
        await validate(file)
      } catch (e) {
        if (previous) await writeFile(file, previous)
        throw e
      }
      const sources = await readSources(dirname(file))
      sources[basename(file)] = { url: entry.url, sha256: sha256(body), bytes: body.length }
      await writeSources(dirname(file), sources)
      console.log(
        `✓ ${name}: updated, sha256 ${short(entry.sha256)} → ${short(sha256(body))} (${sizeOf(body.length)})`,
      )
      changed.push(name)
    } catch (e) {
      failed++
      console.error(`✗ ${name}: ${e instanceof Error ? e.message : e}`)
    }
  }
  if (changed.length) await generateServices(project, loader, changed)
  return failed ? 2 : 0
}
