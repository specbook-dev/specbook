import { readFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { credentialsFromSpec, type SpecCredentials } from '@specbook/core'
import { describe, expect, it, vi } from 'vitest'
import {
  applyCredentials,
  authValue,
  credentialsSnippet,
  planCredentials,
} from '../src/commands/add-auth'
import { initCommand } from '../src/commands/init'

const header = (name: string) => ({ type: 'apiKey', in: 'header', name })
const plaid = (service = 'plaid'): SpecCredentials =>
  credentialsFromSpec(
    {
      security: [{ clientId: [], secret: [], plaidVersion: [] }],
      components: {
        securitySchemes: {
          clientId: header('PLAID-CLIENT-ID'),
          secret: header('PLAID-SECRET'),
          plaidVersion: header('Plaid-Version'),
        },
      },
    },
    service,
  )
const oneKey = (service: string): SpecCredentials =>
  credentialsFromSpec(
    {
      security: [{ api_key: [] }],
      components: { securitySchemes: { api_key: header('api_key') } },
    },
    service,
  )

/** The config `specbook init` writes, as it is on disk. */
async function initConfig(): Promise<string> {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const dir = await mkdtemp(join(tmpdir(), 'sb-add-auth-'))
  await initCommand(dir, { agents: false })
  vi.restoreAllMocks()
  return readFile(join(dir, '.specbook/specbook.config.ts'), 'utf8')
}
const edit = (text: string, creds: SpecCredentials, loaded = {}) =>
  applyCredentials(text, planCredentials(text, creds, loaded))
const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0

describe('credentials in the config init writes', () => {
  it('makes secrets and auth between vars and services, and keeps the commented example', async () => {
    const out = edit(await initConfig(), plaid()) as string
    expect(out).toContain(
      '  // values come from environment variables of the same name or a gitignored <env>.secrets.env\n' +
        '  secrets: { PLAID_CLIENT_ID: {}, PLAID_SECRET: {}, PLAID_VERSION: {} },\n',
    )
    expect(out).toContain(
      [
        '  auth: {',
        '    plaid: {',
        "      // from the spec's security: clientId, secret, plaidVersion",
        "      title: 'API keys',",
        "      scheme: ['clientId', 'secret', 'plaidVersion'],",
        '      apply: {',
        '        headers: {',
        "          'PLAID-CLIENT-ID': '{{secrets.PLAID_CLIENT_ID}}',",
        "          'PLAID-SECRET': '{{secrets.PLAID_SECRET}}',",
        "          'Plaid-Version': '{{secrets.PLAID_VERSION}}',",
        '        },',
        '      },',
        '    },',
        '  },',
        '',
      ].join('\n'),
    )
    const at = (s: string) => out.indexOf(s)
    expect(at('vars: {')).toBeLessThan(at('secrets: {'))
    expect(at('secrets: {')).toBeLessThan(at('auth: {'))
    expect(at('auth: {')).toBeLessThan(at('services: {'))
    expect(out).toContain("// petstore: { spec: './openapi/petstore.json'")
  })

  it('writes a single header on one line', async () => {
    const out = edit(await initConfig(), oneKey('petstore')) as string
    expect(out).toContain(
      "      apply: { headers: { api_key: '{{secrets.PETSTORE_API_KEY}}' } },\n",
    )
  })

  it('ignores a commented-out secrets line', async () => {
    const text = (await initConfig()).replace(
      '  services: {',
      '  // secrets: { OLD: {} },\n  services: {',
    )
    const out = edit(text, oneKey('petstore')) as string
    expect(count(out, /^ {2}secrets: \{ PETSTORE_API_KEY: \{\} \},$/gm)).toBe(1)
    expect(out).toContain('// secrets: { OLD: {} },')
  })

  it('quotes a profile name that is not an identifier', async () => {
    const out = edit(await initConfig(), oneKey('my-api')) as string
    expect(out).toContain("    'my-api': {")
    expect(out).toContain('MY_API_API_KEY: {}')
  })

  it('leaves no bare newline in a file with CRLF line endings', async () => {
    const crlf = (await initConfig()).replace(/\n/g, '\r\n')
    const out = edit(crlf, plaid()) as string
    expect(out).toContain('PLAID_SECRET')
    expect(count(out, /(?<!\r)\n/g)).toBe(0)
  })

  it('follows a file indented with tabs', async () => {
    const tabs = (await initConfig()).replace(/^ {2}/gm, '\t')
    const out = edit(tabs, oneKey('petstore')) as string
    expect(out).toContain('\tsecrets: { PETSTORE_API_KEY: {} },\n')
    expect(out).toContain(
      "\tauth: {\n\t\tpetstore: {\n\t\t\t// from the spec's security: api_key\n",
    )
  })

  it('wraps a long list of secrets', async () => {
    const creds = credentialsFromSpec(
      {
        security: [{ a: [], b: [], c: [], d: [], e: [] }],
        components: {
          securitySchemes: Object.fromEntries(
            ['a', 'b', 'c', 'd', 'e'].map((n) => [n, header(`X-Very-Long-Header-Name-${n}`)]),
          ),
        },
      },
      'a-service-with-a-long-name',
    )
    const out = edit(await initConfig(), creds) as string
    expect(out).toContain('  secrets: {\n    A_SERVICE_WITH_A_LONG_NAME_A: {},')
  })
})

describe('credentials in a config that has secrets and auth already', () => {
  const example = readFileSync(
    resolve(__dirname, '../../../apps/example/.specbook/specbook.config.ts'),
    'utf8',
  )

  it('adds the secret to the one-line block and the profile to the existing auth block', () => {
    const out = edit(example, oneKey('pets2')) as string
    expect(out).toContain(
      'secrets: { PETS2_API_KEY: {}, PETSTORE_API_KEY: {}, PETSTORE_AUTH: {}, STRIPE_API_KEY: {}, GITHUB_TOKEN: {} },',
    )
    expect(out).toContain(
      "  auth: {\n    pets2: {\n      // from the spec's security: api_key\n      title: 'API key',",
    )
    // one block each, and what was there is as it was
    expect(count(out, /^ {2}secrets:/gm)).toBe(1)
    expect(count(out, /^ {2}auth: \{/gm)).toBe(1)
    expect(count(out, /^ {6}auth: '/gm)).toBe(2)
    expect(count(out, /^ {6}auth: \[/gm)).toBe(1)
    expect(out).toContain(
      '// Static-token profile: no login, the secret is applied to every request that accepts it.',
    )
    expect(out).toContain("'x-github-api-version': '2022-11-28',")
  })

  it('reuses a secret that is already declared and does not write it twice', () => {
    const plan = planCredentials(example, oneKey('petstore2'), {
      secrets: { PETSTORE2_API_KEY: {} },
    })
    expect(plan.reused).toEqual(['PETSTORE2_API_KEY'])
    expect(plan.add).toEqual([])
    const out = applyCredentials(example, plan) as string
    expect(count(out, /PETSTORE2_API_KEY: \{\}/g)).toBe(0)
    expect(out).toContain('petstore2: {')
  })

  it('leaves a profile of the same name alone and says so', () => {
    const plan = planCredentials(example, oneKey('stripe'))
    expect(plan.profiles).toEqual([])
    expect(plan.notes[0]).toContain('a profile named "stripe" is already in the config')
    expect(applyCredentials(example, plan)).toBeUndefined()
  })

  it('does not take a name from the loaded config alone: it reads the text too', () => {
    // two adds in one process: the loaded config is from before the first
    const first = edit(example, oneKey('pets2')) as string
    const plan = planCredentials(first, oneKey('pets2'), {})
    expect(plan.profiles).toEqual([])
  })
})

describe('credentials in a config that is written another way', () => {
  const shell = (middle: string) =>
    `export default defineConfig({\n  project: 'p',\n${middle}  services: {\n  },\n})\n`

  it('fills empty secrets and auth blocks', () => {
    const out = edit(shell('  secrets: {},\n  auth: {},\n'), oneKey('petstore')) as string
    expect(out).toContain('secrets: { PETSTORE_API_KEY: {} },')
    expect(out).toContain('  auth: {\n    petstore: {\n')
    expect(count(out, /^ {2}auth: \{/gm)).toBe(1)
  })

  it('does not edit a secrets block that is not a literal', () => {
    const text = shell('  secrets: shared,\n')
    const plan = planCredentials(text, oneKey('petstore'))
    expect(plan.manual).toBe(true)
    expect(applyCredentials(text, plan)).toBeUndefined()
  })

  it('does not guess where a comma goes in a one-line auth block with entries', () => {
    const plan = planCredentials(shell('  auth: { other: { apply: {} } },\n'), oneKey('petstore'))
    expect(plan.manual).toBe(true)
  })

  it('adds to the top of a block that spreads another, and writes nothing without a services block', () => {
    const spread = edit(shell('  secrets: { ...shared },\n'), oneKey('petstore')) as string
    expect(spread).toContain('secrets: { PETSTORE_API_KEY: {}, ...shared },')
    expect(
      applyCredentials('export default {}\n', planCredentials('export default {}\n', oneKey('p'))),
    ).toBeUndefined()
  })

  it('does nothing when the spec has no credentials, and keeps its notes', () => {
    const creds: SpecCredentials = {
      profiles: [],
      secrets: [],
      notes: ['mtls cannot be sent as a header or a query value'],
      vars: {},
      environmentVars: {},
    }
    const plan = planCredentials(shell(''), creds)
    expect(plan.profiles).toEqual([])
    expect(plan.notes).toEqual(creds.notes)
    expect(applyCredentials(shell(''), plan)).toBeUndefined()
  })
})

describe('the snippet for a config that cannot be edited', () => {
  it('has the secrets, the profile and the service line', () => {
    const snippet = credentialsSnippet(plaid())
    expect(snippet).toContain(
      'secrets: { PLAID_CLIENT_ID: {}, PLAID_SECRET: {}, PLAID_VERSION: {} },',
    )
    expect(snippet).toContain('auth: {')
    expect(snippet).toContain("'Plaid-Version': '{{secrets.PLAID_VERSION}}',")
    expect(snippet).toContain("`auth: 'plaid',`")
    expect(
      credentialsSnippet({ profiles: [], secrets: [], notes: [], vars: {}, environmentVars: {} }),
    ).toBe('')
  })
})

describe('every way a spec accepts', () => {
  const petstoreDoc = {
    components: {
      securitySchemes: {
        api_key: header('api_key'),
        petstore_auth: {
          type: 'oauth2',
          flows: {
            implicit: {
              authorizationUrl: 'https://auth.test/authorize',
              scopes: { 'read:pets': 'Read' },
            },
          },
        },
      },
    },
    paths: {
      '/a': { get: { security: [{ api_key: [] }, { petstore_auth: ['read:pets'] }] } },
      '/b': { get: { security: [{ petstore_auth: ['read:pets'] }] } },
    },
  }
  const creds = credentialsFromSpec(petstoreDoc, 'petstore')

  it('writes a profile for each, with the scheme it satisfies and the sign-in settings', async () => {
    const out = edit(await initConfig(), creds) as string
    expect(out).toContain('secrets: { PETSTORE_API_KEY: {}, PETSTORE_AUTH: {} },')
    expect(out).toContain(
      [
        '    petstore: {',
        "      // from the spec's security: api_key",
        "      title: 'API key',",
        "      scheme: 'api_key',",
        "      apply: { headers: { api_key: '{{secrets.PETSTORE_API_KEY}}' } },",
        '    },',
        "    'petstore-auth': {",
        "      // from the spec's security: petstore_auth",
        "      title: 'OAuth sign-in',",
        "      scheme: 'petstore_auth',",
        "      apply: { headers: { authorization: 'Bearer {{secrets.PETSTORE_AUTH}}' } },",
        '      oauth: {',
        "        flow: 'implicit',",
        "        authorizationUrl: 'https://auth.test/authorize',",
        '        scopes: {',
        "          'read:pets': 'Read',",
        '        },',
        '      },',
        '    },',
      ].join('\n'),
    )
  })

  it('names the service by its list when there are several, and by its name when there is one', () => {
    expect(authValue(creds.profiles)).toBe("['petstore', 'petstore-auth']")
    expect(authValue(creds.profiles.slice(0, 1))).toBe("'petstore'")
  })

  it('leaves a profile the config has under another name of its own and writes the rest', async () => {
    const text = (await initConfig()).replace(
      '  services: {',
      "  auth: {\n    'petstore-auth': { apply: {} },\n  },\n  services: {",
    )
    const plan = planCredentials(text, creds)
    expect(plan.profiles.map((p) => p.name)).toEqual(['petstore'])
    expect(plan.notes).toContain(
      'a profile named "petstore-auth" is already in the config; left as it is',
    )
  })

  it('has every profile in the snippet for a config that cannot be edited', () => {
    const snippet = credentialsSnippet(creds)
    expect(snippet).toContain("'petstore-auth': {")
    expect(snippet).toContain("`auth: ['petstore', 'petstore-auth'],`")
  })
})
