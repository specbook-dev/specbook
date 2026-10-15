import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { secretsCommand } from '../src/commands/secrets'
import type { Project } from '../src/project'

describe('specbook secrets', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    Reflect.deleteProperty(process.env, 'ENV_ONLY_KEY')
  })

  const project = async (): Promise<Project> => {
    const root = await mkdtemp(join(tmpdir(), 'sb-secrets-'))
    await mkdir(join(root, '.specbook/environments'), { recursive: true })
    await writeFile(join(root, '.specbook/environments/staging.secrets.env'), 'STAGE_KEY=s\n')
    await writeFile(join(root, '.specbook/secrets.local.env'), 'SHARED_KEY=x\n')
    return {
      root,
      configFile: join(root, '.specbook/specbook.config.ts'),
      config: {
        project: 't',
        services: {},
        secrets: {
          STAGE_KEY: {},
          SHARED_KEY: {},
          ENV_ONLY_KEY: {},
          RENAMED: { env: 'OTHER_NAME' },
          GONE: {},
        },
      },
    }
  }

  it('says where each secret resolves from and exits 1 when one is missing, never printing values', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')))
    process.env.ENV_ONLY_KEY = 'secret-value-123'
    const code = await secretsCommand(await project(), 'staging')
    const out = lines.join('\n')
    expect(code).toBe(1)
    expect(out).toContain('✓ STAGE_KEY')
    expect(out).toContain('environments/staging.secrets.env')
    expect(out).toContain('secrets.local.env (shared)')
    expect(out).toContain('environment variable')
    expect(out).toContain('✗ GONE')
    expect(out).toContain('set OTHER_NAME')
    expect(out).not.toContain('secret-value-123')
  })

  it('does not see another environment’s file', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')))
    await secretsCommand(await project(), 'live')
    expect(lines.join('\n')).toContain('✗ STAGE_KEY')
  })
})
