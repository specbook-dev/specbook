import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseDotenv, type SpecbookConfig } from '@specbook/core/internal'
import type { Loader } from './load'

const CANDIDATES = [
  '.specbook/specbook.config.ts',
  'specbook.config.ts',
  '.specbook/specbook.config.mjs',
]

export function findConfigFile(cwd: string): string | undefined {
  let dir = resolve(cwd)
  for (;;) {
    for (const c of CANDIDATES) {
      const p = join(dir, c)
      if (existsSync(p)) return p
    }
    const up = dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}

/** The project's folder: the one that holds `.specbook/`, or the config's own. */
export function rootOf(configFile: string): string {
  return configFile.endsWith(`${join('.specbook', 'specbook.config.ts')}`)
    ? dirname(dirname(configFile))
    : dirname(configFile)
}

export interface Project {
  root: string
  configFile: string
  config: SpecbookConfig
}

export async function loadProject(cwd: string, loader: Loader): Promise<Project> {
  const configFile = findConfigFile(cwd)
  if (!configFile)
    throw new Error('No specbook config found (looked for .specbook/specbook.config.ts)')
  const mod = await loader.import<{ default: SpecbookConfig }>(configFile)
  return { root: rootOf(configFile), configFile, config: mod.default }
}

export async function readDotenv(path: string): Promise<Record<string, string>> {
  if (!existsSync(path)) return {}
  return parseDotenv(await readFile(path, 'utf8'))
}
