import { existsSync } from 'node:fs'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentBlock, agentsStep, importsAgents, readGuide, withBlock } from '../src/commands/agents'

/** What `specbook init` does about the files coding agents read. It must never edit one it did not make, unless asked. */

const dir = () => mkdtemp(join(tmpdir(), 'sb-agents-'))
const read = (d: string, f: string) => readFile(join(d, f), 'utf8')

async function run(d: string, agents?: boolean) {
  const out: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')))
  try {
    await agentsStep(d, agents)
  } finally {
    spy.mockRestore()
  }
  return out.join('\n')
}

afterEach(() => vi.restoreAllMocks())

describe('the block', () => {
  it('is appended to a file, and a second time changes nothing', () => {
    const first = withBlock('# Mine\n\nHouse rules.\n')
    expect(first.status).toBe('added')
    expect(first.text.startsWith('# Mine\n\nHouse rules.\n\n<!-- specbook:start')).toBe(true)
    expect(first.text.endsWith('<!-- specbook:end -->\n')).toBe(true)
    const again = withBlock(first.text)
    expect(again.status).toBe('unchanged')
    expect(again.text).toBe(first.text)
  })

  it('keeps everything outside its markers byte for byte when it replaces itself', () => {
    const before = 'top\n\n'
    const after = '\n\nbottom, with   odd spacing\t\n'
    const stale = `${before}<!-- specbook:start (old) -->\nold words\n<!-- specbook:end -->${after}`
    const r = withBlock(stale)
    expect(r.status).toBe('updated')
    expect(r.text.startsWith(before)).toBe(true)
    expect(r.text.endsWith(after)).toBe(true)
    expect(r.text).not.toContain('old words')
  })

  it('handles an empty file, a file with no final newline, and CRLF', () => {
    expect(withBlock('').text.startsWith('<!-- specbook:start')).toBe(true)
    expect(withBlock('no newline').text.startsWith('no newline\n\n<!-- specbook:start')).toBe(true)
    const crlf = withBlock('line one\r\nline two\r\n').text
    expect(crlf.replace(/\r\n/g, '')).not.toContain('\n')
    expect(crlf).toContain(`${agentBlock('\r\n')}\r\n`)
  })

  it('leaves a start marker with no end marker alone', () => {
    const text = 'x\n<!-- specbook:start\nsomeone else wrote this\n'
    const r = withBlock(text)
    expect(r).toEqual({ text, status: 'unterminated' })
  })

  it('knows a CLAUDE.md that imports AGENTS.md', () => {
    expect(importsAgents('# Claude\n@AGENTS.md\n')).toBe(true)
    expect(importsAgents('see @AGENTS.md for more')).toBe(false)
  })
})

describe('specbook init and the agent files', () => {
  it('in a project with neither file, writes the guide and creates AGENTS.md', async () => {
    const d = await dir()
    const said = await run(d)
    const guide = await read(d, '.specbook/agent-guide.md')
    expect(guide).toMatch(/^<!-- Written by specbook init v\d/)
    expect(guide).toContain('## Write isomorphic code')
    const agents = await read(d, 'AGENTS.md')
    expect(agents).toContain('.specbook/agent-guide.md')
    expect(agents).toContain('isomorphic')
    expect(agents).toContain('auth profile')
    expect(agents).toContain('ctx.captured')
    expect(agents).toContain('tsc --noEmit')
    expect(said).toContain('created AGENTS.md')
    // one file is enough: Claude Code reads AGENTS.md when there is no CLAUDE.md
    expect(existsSync(join(d, 'CLAUDE.md'))).toBe(false)
  })

  it('does not touch an AGENTS.md that exists, and says how to add the section', async () => {
    const d = await dir()
    const mine = '# Our rules\n\nUse tabs.\n'
    await writeFile(join(d, 'AGENTS.md'), mine)
    const said = await run(d)
    expect(await read(d, 'AGENTS.md')).toBe(mine)
    expect(said).toContain('AGENTS.md already exists and was not changed')
    expect(said).toContain('specbook init --agents')
    // the guide itself is Specbook's own file, so it is still written
    expect(existsSync(join(d, '.specbook/agent-guide.md'))).toBe(true)
  })

  it('with --agents adds the section once and leaves the rest alone, however often it runs', async () => {
    const d = await dir()
    const mine = '# Our rules\n\nUse tabs.\n'
    await writeFile(join(d, 'AGENTS.md'), mine)
    await run(d, true)
    const once = await read(d, 'AGENTS.md')
    expect(once.startsWith(mine)).toBe(true)
    expect(once.match(/specbook:start/g)).toHaveLength(1)
    const said = await run(d, true)
    expect(await read(d, 'AGENTS.md')).toBe(once)
    expect(said).toContain("already has Specbook's section")
  })

  it('puts the section in CLAUDE.md when that is the file there is, and creates no AGENTS.md', async () => {
    const d = await dir()
    await writeFile(join(d, 'CLAUDE.md'), '# Claude notes\n')
    await run(d)
    expect(await read(d, 'CLAUDE.md')).toBe('# Claude notes\n')
    expect(existsSync(join(d, 'AGENTS.md'))).toBe(false)
    await run(d, true)
    expect(await read(d, 'CLAUDE.md')).toContain('specbook:start')
    expect(existsSync(join(d, 'AGENTS.md'))).toBe(false)
  })

  it('writes both files when both exist, since Claude Code reads only CLAUDE.md then', async () => {
    const d = await dir()
    await writeFile(join(d, 'AGENTS.md'), '# A\n')
    await writeFile(join(d, 'CLAUDE.md'), '# C\n')
    await run(d, true)
    expect(await read(d, 'AGENTS.md')).toContain('specbook:start')
    expect(await read(d, 'CLAUDE.md')).toContain('specbook:start')
  })

  it('leaves a CLAUDE.md that imports AGENTS.md alone: the section reaches Claude through the import', async () => {
    const d = await dir()
    await writeFile(join(d, 'AGENTS.md'), '# A\n')
    await writeFile(join(d, 'CLAUDE.md'), '@AGENTS.md\n')
    const said = await run(d, true)
    expect(await read(d, 'CLAUDE.md')).toBe('@AGENTS.md\n')
    expect(await read(d, 'AGENTS.md')).toContain('specbook:start')
    expect(said).toContain('CLAUDE.md imports AGENTS.md')
  })

  it('treats a CLAUDE.md that is a symlink to AGENTS.md as one file', async () => {
    const d = await dir()
    await writeFile(join(d, 'AGENTS.md'), '# A\n')
    await symlink(join(d, 'AGENTS.md'), join(d, 'CLAUDE.md'))
    await run(d, true)
    expect((await read(d, 'AGENTS.md')).match(/specbook:start/g)).toHaveLength(1)
  })

  it('writes nothing for --no-agents', async () => {
    const d = await dir()
    const said = await run(d, false)
    expect(said).toBe('')
    expect(existsSync(join(d, 'AGENTS.md'))).toBe(false)
    expect(existsSync(join(d, '.specbook/agent-guide.md'))).toBe(false)
  })

  it('warns and changes nothing for a start marker with no end', async () => {
    const d = await dir()
    const odd = '# A\n<!-- specbook:start\nhand written\n'
    await writeFile(join(d, 'AGENTS.md'), odd)
    const said = await run(d, true)
    expect(await read(d, 'AGENTS.md')).toBe(odd)
    expect(said).toContain('no end marker')
  })
})

describe('the guide', () => {
  it('ships in the package, and states the rules an agent needs', async () => {
    const pkg = JSON.parse(await readFile(join(__dirname, '../package.json'), 'utf8'))
    expect(pkg.files).toContain('agent-guide.md')
    const guide = await readGuide()
    for (const must of [
      '## Auth and secrets',
      '## Add a request',
      '## Asserts',
      '## Capture',
      '## Build a flow',
      '## Add a script',
      '### Chain steps with types, not strings',
      '## Write isomorphic code',
      'Buffer',
      'process.env',
      '--external',
      'tsc --noEmit',
      'ctx.captured',
    ])
      expect(guide, must).toContain(must)
  })
})
