import { createRequire } from 'node:module'

/** The version of this CLI, from its package.json (whichever layout it is run from). */
export function cliVersion(): string {
  const require = createRequire(import.meta.url)
  for (const p of ['../package.json', '../../package.json'])
    try {
      return (require(p) as { version: string }).version
    } catch {
      /* the other layout */
    }
  return ''
}
