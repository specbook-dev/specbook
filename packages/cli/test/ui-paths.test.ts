import { describe, expect, it } from 'vitest'
import { enclosingNodeModules, nodeModulesOf } from '../src/commands/ui'

describe('nodeModulesOf', () => {
  it('names the innermost node_modules a file sits in', () => {
    expect(nodeModulesOf('/h/.npm/_npx/ab/node_modules/prism-code-editor/dist/index.js')).toBe(
      '/h/.npm/_npx/ab/node_modules',
    )
    expect(nodeModulesOf('/p/node_modules/.pnpm/vite@1/node_modules/vite/dist/index.js')).toBe(
      '/p/node_modules/.pnpm/vite@1/node_modules',
    )
  })
  it('has none for a file outside any', () => {
    expect(nodeModulesOf('/p/src/index.js')).toBeUndefined()
  })
})

describe('enclosingNodeModules', () => {
  it('lists each node_modules a file is inside, innermost first', () => {
    expect(
      enclosingNodeModules('/h/.npm/_npx/ab/node_modules/@specbook/cli/node_modules/x/dist/a.js'),
    ).toEqual([
      '/h/.npm/_npx/ab/node_modules/@specbook/cli/node_modules',
      '/h/.npm/_npx/ab/node_modules',
    ])
    expect(enclosingNodeModules('/p/src/a.js')).toEqual([])
  })
})
