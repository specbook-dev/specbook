// The licence notices for what the viewer build contains. MIT, BSD and ISC ask that the copyright and
// licence text travel with copies, and the viewer is shipped as minified bundles (on the site, in the
// release zip and in the @specbook/ui package), where the original comments are not reliably kept.
//
// A pair of Vite plugins: `collect` runs in the main build and in the worker build (which is a separate
// one) and records every package that ended up in a chunk; `emit` runs last in the main build and writes
// THIRD-PARTY-NOTICES.txt next to the bundles. A package under a licence that has not been looked at
// fails the build, so a new dependency cannot arrive unnoticed.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Licences that have been read and are fine to redistribute in a bundle with their notice. */
export const ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'MPL-2.0',
  'Python-2.0',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
])

/**
 * The package a file belongs to: the folder directly under the last `node_modules` (two levels for a
 * scope). Entry points such as `preact/hooks` carry a package.json of their own, which is not the package.
 */
export function packageOf(file) {
  const clean = file.split('?')[0].replace(/^\0/, '')
  const marker = 'node_modules/'
  const at = clean.lastIndexOf(marker)
  if (at < 0) return undefined
  const rest = clean.slice(at + marker.length).split('/')
  const parts = rest[0]?.startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1)
  if (parts.length === 0 || parts.some((p) => !p)) return undefined
  const dir = clean.slice(0, at + marker.length) + parts.join('/')
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return pkg.name ? { dir, pkg } : undefined
  } catch {
    return undefined
  }
}

/** The licence of a package as one SPDX-ish string. */
export function licenseName(pkg) {
  const l = pkg.license ?? pkg.licenses
  if (typeof l === 'string') return l.trim()
  if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : x.type)).join(' OR ')
  if (l && typeof l === 'object') return String(l.type ?? '')
  return ''
}

/** The text of the licence file a package ships, if it ships one. */
export function licenseText(dir) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return undefined
  }
  const file = names.find((n) => /^(licen[cs]e|copying)(\.[a-z]+)?$/i.test(n))
  return file ? readFileSync(join(dir, file), 'utf8').trim() : undefined
}

/** Whether a (possibly compound) licence expression only uses allowed licences. */
export function isAllowed(expression) {
  const parts = expression
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND)\s+|\s+/)
    .filter(Boolean)
  return parts.length > 0 && parts.every((p) => ALLOWED.has(p) || p === 'OR' || p === 'AND')
}

export function render(entries) {
  const rule = '-'.repeat(78)
  const body = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (e) =>
        `${rule}\n${e.name} ${e.version}\nLicence: ${e.license}\n\n${e.text ?? `(the package ships no licence file; it declares ${e.license})`}\n`,
    )
    .join('\n')
  return `Third-party notices

The Specbook viewer contains the software listed below, under the licences shown.
Specbook itself is MIT licensed (see the LICENSE file of the repository).

${body}`
}

export function noticesPlugins() {
  /** package dir -> entry */
  const used = new Map()
  const note = (id) => {
    const found = packageOf(id)
    if (!found || used.has(found.dir)) return
    const { dir, pkg } = found
    // our own packages are not third-party
    if (pkg.name.startsWith('@specbook/')) return
    used.set(dir, {
      name: pkg.name,
      version: pkg.version ?? '',
      license: licenseName(pkg) || 'UNKNOWN',
      text: licenseText(dir),
    })
  }
  const collect = {
    name: 'specbook-collect-licenses',
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle))
        if (item.type === 'chunk') for (const id of Object.keys(item.modules ?? {})) note(id)
    },
  }
  const emit = {
    name: 'specbook-third-party-notices',
    // after the worker build, which runs while the main one is transforming
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle))
        if (item.type === 'chunk') for (const id of Object.keys(item.modules ?? {})) note(id)
      const entries = [...used.values()]
      const unknown = entries.filter((e) => !isAllowed(e.license))
      if (unknown.length)
        this.error(
          `Licences that have not been reviewed are in the viewer bundle:\n${unknown
            .map((e) => `  ${e.name}@${e.version}: ${e.license}`)
            .join('\n')}\nRead each, then add it to ALLOWED in scripts/third-party-notices.mjs.`,
        )
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD-PARTY-NOTICES.txt',
        source: render(entries),
      })
    },
  }
  return { collect, emit }
}
