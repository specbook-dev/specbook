import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A terminal snippet is real output, which names the version that printed it. A release changes the version, and a snippet
 * nobody re-recorded would go on saying the old one on the page.
 */
const docs = process.cwd()
const version = (
  JSON.parse(readFileSync(join(docs, '../../packages/cli/package.json'), 'utf8')) as {
    version: string
  }
).version

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

describe('terminal snippets', () => {
  it('name the version of the CLI that is being released', () => {
    const stale: string[] = []
    for (const f of files(join(docs, 'snippets')))
      for (const m of readFileSync(f, 'utf8').matchAll(/specbook [a-z]+ (\d+\.\d+\.\d+)\b/g))
        if (m[1] !== version) stale.push(`${f.slice(docs.length + 1)} says ${m[1]}`)
    expect(stale, `re-record them: the CLI is ${version}`).toEqual([])
  })
})
