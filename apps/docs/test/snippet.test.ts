import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { dedent, readSnippet, region } from '../src/lib/snippet'

let base: string
const read = (file: string, extra: object = {}) =>
  readSnippet({ file, base, roots: ['demo'], ...extra })

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'sb-snippet-'))
  await mkdir(join(base, 'demo'), { recursive: true })
  await mkdir(join(base, 'other'), { recursive: true })
  await writeFile(
    join(base, 'demo/flow.ts'),
    [
      "import { x } from 'y'",
      '',
      '// #region flow',
      'export default sequence({',
      '  id: 1,',
      '  // #region inner',
      '  inputs: {},',
      '  // #endregion inner',
      '})',
      '// #endregion flow',
      '',
      '// #region other',
      '// #endregion other',
      '// #region open',
      'never closed',
    ].join('\n'),
  )
  await writeFile(
    join(base, 'demo/ci.yml'),
    ['jobs:', '  # #region step', '  - run: node specbook-tests.mjs', '  # #endregion step'].join(
      '\n',
    ),
  )
  await writeFile(
    join(base, 'demo/note.md'),
    ['text', '<!-- #region tip -->', '    indented', '      more', '<!-- #endregion tip -->'].join(
      '\n',
    ),
  )
  await writeFile(join(base, 'other/secret.ts'), 'export const secret = 1')
})

describe('a region of a file', () => {
  it('is the text between its markers, with the markers gone and the indentation tidied', () => {
    expect(read('demo/flow.ts', { region: 'flow' }).code).toBe(
      ['export default sequence({', '  id: 1,', '  inputs: {},', '})'].join('\n'),
    )
    expect(read('demo/flow.ts', { region: 'inner' }).code).toBe('inputs: {},')
  })

  it('works with the comment style of any language', () => {
    expect(read('demo/ci.yml', { region: 'step' })).toMatchObject({
      code: '- run: node specbook-tests.mjs',
      lang: 'yaml',
    })
    expect(read('demo/note.md', { region: 'tip' }).code).toBe('indented\n  more')
  })

  it('fails the build for a region that is not there, is empty, or is never closed', () => {
    expect(() => read('demo/flow.ts', { region: 'nope' })).toThrow('has no "#region nope"')
    expect(() => read('demo/flow.ts', { region: 'other' })).toThrow('is empty')
    expect(() => read('demo/flow.ts', { region: 'open' })).toThrow('never closed')
  })
})

describe('a snippet', () => {
  it('can be a range of lines, or the whole file without its markers', () => {
    expect(read('demo/flow.ts', { lines: '4-5' }).code).toBe('export default sequence({\n  id: 1,')
    expect(() => read('demo/flow.ts', { lines: '9-99' })).toThrow('outside')
    expect(() => read('demo/flow.ts', { lines: 'a-b' })).toThrow('not like 3-9')
    const whole = read('demo/ci.yml').code
    expect(whole).toContain('node specbook-tests.mjs')
    expect(whole).not.toContain('#region')
  })

  it('names the file and its language', () => {
    expect(read('demo/flow.ts', { region: 'flow' })).toMatchObject({ lang: 'ts', name: 'flow.ts' })
  })

  it('only comes from the places snippets are allowed to', () => {
    expect(() => read('other/secret.ts')).toThrow('not under demo')
    expect(() => read('demo/../other/secret.ts')).toThrow('not under demo')
    expect(() => read('demo/missing.ts')).toThrow('does not exist')
  })

  it('dedents by what every non-empty line shares', () => {
    expect(dedent(['    a', '', '      b'])).toEqual(['a', '', '  b'])
    expect(region('// #region r\n  x\n// #endregion r', 'r')).toEqual(['x'])
  })
})

describe('the snippets the site really uses', () => {
  const real = (file: string, name: string) => readSnippet({ file, region: name })

  it('are in the demo project, which is type-checked and run in CI', () => {
    expect(real('demo/requests/petstore/get-pet.req.ts', 'request').code).toContain(
      'GetPetById.request',
    )
    expect(real('demo/sequences/adopt-pet.seq.ts', 'flow').code).toContain("id: 'adopt-pet'")
    expect(real('demo/sequences/new-pet.seq.ts', 'flow').code).toContain('faker.person.firstName')
  })
})
