import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isAllowed,
  licenseName,
  licenseText,
  noticesPlugins,
  packageOf,
  render,
} from '../scripts/third-party-notices.mjs'

/** A throwaway node_modules tree: `<root>/node_modules/.pnpm/<dir>/node_modules/<name>`. */
function tree() {
  const root = mkdtempSync(join(tmpdir(), 'sb-notices-'))
  const pkg = (rel: string, json: object, license?: string) => {
    const dir = join(root, rel)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(json))
    if (license) writeFileSync(join(dir, 'LICENSE'), license)
    return dir
  }
  return { root, pkg }
}

describe('packageOf', () => {
  it('finds the package under the last node_modules, scoped or not, in a pnpm layout', () => {
    const { root, pkg } = tree()
    const plain = pkg('node_modules/.pnpm/preact@1/node_modules/preact', {
      name: 'preact',
      version: '1',
    })
    const scoped = pkg('node_modules/.pnpm/s@1/node_modules/@scope/lib', {
      name: '@scope/lib',
      version: '2',
    })
    expect(packageOf(join(plain, 'dist/preact.mjs'))?.pkg.name).toBe('preact')
    expect(packageOf(join(scoped, 'src/index.js'))?.pkg.name).toBe('@scope/lib')
    expect(packageOf(join(root, 'src/app.ts'))).toBeUndefined()
  })

  it('does not mistake an entry point with its own package.json for the package', () => {
    const { pkg } = tree()
    const dir = pkg('node_modules/preact', { name: 'preact', version: '1' })
    pkg('node_modules/preact/hooks', { name: 'preact-hooks', main: 'dist/hooks.js' })
    expect(packageOf(join(dir, 'hooks/dist/hooks.mjs?v=1'))?.pkg.name).toBe('preact')
  })
})

describe('licences', () => {
  it('reads the name in each of the shapes a package.json uses', () => {
    expect(licenseName({ license: 'MIT' })).toBe('MIT')
    expect(licenseName({ license: { type: 'ISC' } })).toBe('ISC')
    expect(licenseName({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe(
      'MIT OR Apache-2.0',
    )
    expect(licenseName({})).toBe('')
  })

  it('reads the licence file a package ships', () => {
    const { pkg } = tree()
    expect(licenseText(pkg('node_modules/a', { name: 'a' }, 'Permission is hereby granted'))).toBe(
      'Permission is hereby granted',
    )
    expect(licenseText(pkg('node_modules/b', { name: 'b' }))).toBeUndefined()
  })

  it('allows only licences that have been reviewed', () => {
    expect(isAllowed('MIT')).toBe(true)
    expect(isAllowed('(MIT OR Apache-2.0)')).toBe(true)
    expect(isAllowed('BSD-3-Clause')).toBe(true)
    expect(isAllowed('GPL-3.0')).toBe(false)
    expect(isAllowed('MIT AND GPL-3.0')).toBe(false)
    expect(isAllowed('')).toBe(false)
    expect(isAllowed('UNKNOWN')).toBe(false)
  })
})

describe('the notices file', () => {
  it('lists each package once, with its licence text, and says when there is none', () => {
    const out = render([
      { name: 'zeta', version: '1.0.0', license: 'MIT', text: 'Zeta licence text' },
      { name: 'alpha', version: '2.0.0', license: 'ISC', text: undefined },
    ])
    expect(out.indexOf('alpha 2.0.0')).toBeLessThan(out.indexOf('zeta 1.0.0'))
    expect(out).toContain('Zeta licence text')
    expect(out).toContain('ships no licence file; it declares ISC')
  })

  it('fails the build for a package under a licence nobody has reviewed', () => {
    const { pkg } = tree()
    const dir = pkg('node_modules/copyleft', { name: 'copyleft', version: '1', license: 'GPL-3.0' })
    const { emit } = noticesPlugins()
    const bundle = { 'a.js': { type: 'chunk', modules: { [join(dir, 'index.js')]: {} } } }
    let message = ''
    const context = {
      error: (m: string) => {
        message = m
        throw new Error(m)
      },
      emitFile: () => {},
    }
    expect(() =>
      (emit.generateBundle as (this: typeof context, o: unknown, b: unknown) => void).call(
        context,
        {},
        bundle,
      ),
    ).toThrow()
    expect(message).toContain('copyleft@1: GPL-3.0')
  })
})
