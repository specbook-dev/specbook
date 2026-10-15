import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyViewer } from '../src/commands/ui'
import type { Project } from '../src/project'

describe('build --viewer', () => {
  it('copies the prebuilt viewer next to the site, and says what to do when it is not built', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sb-viewer-'))
    const viewer = join(root, 'dist-viewer')
    await mkdir(join(viewer, 'assets'), { recursive: true })
    await writeFile(join(viewer, 'index.html'), '<div id="app"></div>')
    await writeFile(join(viewer, 'assets/app.js'), 'export {}')
    const project = { root } as Project

    const dest = await copyViewer(project, 'dist-docs', viewer)
    expect(dest).toBe(join(root, 'dist-docs', 'viewer'))
    expect(await readFile(join(dest, 'index.html'), 'utf8')).toContain('id="app"')
    expect(await readFile(join(dest, 'assets/app.js'), 'utf8')).toBe('export {}')

    await expect(copyViewer(project, 'out', join(root, 'missing'))).rejects.toThrow(/build:viewer/)
  })
})
