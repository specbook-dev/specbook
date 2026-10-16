import { createRequire } from 'node:module'

let fixed: string | undefined

/** A bundle was built by some version and cannot read a package.json at run time: it states it. */
export function fixCliVersion(version: string): void {
  fixed = version
}

/** The version of this CLI, from its package.json (whichever layout it is run from). */
export function cliVersion(): string {
  if (fixed !== undefined) return fixed
  const require = createRequire(import.meta.url)
  for (const p of ['../package.json', '../../package.json'])
    try {
      return (require(p) as { version: string }).version
    } catch {
      /* the other layout */
    }
  return ''
}
