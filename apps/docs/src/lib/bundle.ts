import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../../demo/dist-bundle')

/** The test bundle the site offers for download: its size and hash, read from the file the build just made. */
export function bundleFacts() {
  const file = resolve(dist, 'specbook-tests.mjs')
  const hash = resolve(dist, 'specbook-tests.mjs.sha256')
  if (!existsSync(file) || !existsSync(hash)) return { kb: 0, sha256: '', ready: false }
  return {
    kb: Math.round(statSync(file).size / 1024),
    sha256: readFileSync(hash, 'utf8').trim().split(/\s+/)[0] ?? '',
    ready: true,
  }
}
