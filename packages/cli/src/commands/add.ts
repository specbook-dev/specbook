import { readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import SwaggerParser from '@apidevtools/swagger-parser'
import { generateToDisk, withPlainSpec } from '@specbook/codegen'
import {
  credentialsFromSpec,
  openApiServers,
  type ServerEntry,
  type SpecCredentials,
} from '@specbook/core/internal'
import {
  ensureEnvironmentsDir,
  readEnvironment,
  varsFile,
  writeEnvKey,
} from '@specbook/vite/internal'
import type { Project } from '../project'
import { applyCredentials, authValue, credentialsSnippet, planCredentials, quote } from './add-auth'
import { fetchSpec, isUrl, sizeOf } from './spec-source'

/** `petstore` → `petstoreUrl`, `my-api` → `myApiUrl`: the variable a service's address is kept in. */
export const addressVariable = (service: string) =>
  `${service.replace(/[-_]+(.)/g, (_, c: string) => c.toUpperCase())}Url`

/** One line on what a profile takes, from its kind. */
function describeProfile(p: SpecCredentials['profiles'][number]): string {
  const names = p.secrets.join(', ')
  if (p.kind === 'clientCredentials')
    return `profile "${p.name}" signs in server-side with ${p.secrets.join(' and ')}`
  if (p.kind === 'oauth')
    return p.oauth
      ? `profile "${p.name}" signs in with OAuth, or takes a pasted token in ${names}`
      : `profile "${p.name}" takes an access token in ${names}`
  return `profile "${p.name}" sends ${names}`
}

/** What `add` wrote for the spec's security, or why it wrote nothing. */
function reportCredentials(plan: ReturnType<typeof planCredentials>, creds: SpecCredentials) {
  if (plan.profiles.length) {
    const one = plan.profiles.length === 1
    console.log(
      `✓ credentials from the spec: ${one ? '' : `${plan.profiles.length} ways to authenticate, the first is the default\n`}${plan.profiles.map((p) => `${one ? '' : '  '}${describeProfile(p)}`).join('\n')}`,
    )
    console.log(
      '  set the secrets as environment variables or in .specbook/environments/<env>.secrets.env; the mock needs none',
    )
    if (plan.reused.length)
      console.log(
        `  (${plan.reused.join(', ')} ${plan.reused.length === 1 ? 'was' : 'were'} already declared)`,
      )
    for (const note of plan.notes) console.log(`  ${note}`)
  } else if (plan.manual) {
    console.log(
      `The spec's credentials were not written, because secrets or auth in the config is not a plain object. Add this at the top level of it:\n\n${credentialsSnippet(creds)}`,
    )
  } else if (plan.notes.length) {
    console.log('  credentials from the spec were not written:')
    for (const note of plan.notes) console.log(`    ${note}`)
  }
}

/** The credentials as text, for a config `add` could not edit at all. */
const credentialsHint = (creds: SpecCredentials) =>
  creds.profiles.length ? `\nand this at the top level:\n\n${credentialsSnippet(creds)}` : ''

/**
 * Registers a service in the config file (text edit) and generates its code. The address is a variable
 * (`petstoreUrl`, defaulting to the spec's first server) and every other server the spec lists becomes that
 * variable in an environment file of its own, so the project has the environments `preview` would show.
 */
export async function addCommand(
  project: Project,
  service: string,
  spec: string,
  baseUrl?: string,
) {
  if (!/^[A-Za-z][\w-]*$/.test(service)) throw new Error(`Invalid service name "${service}"`)
  if (project.config.services[service])
    throw new Error(`Service "${service}" already exists in the config`)
  // an address is downloaded into openapi/ and recorded in openapi/sources.json; a path is used where it is
  let specAbs = resolve(process.cwd(), spec)
  if (isUrl(spec)) {
    const got = await fetchSpec(project, service, spec)
    specAbs = got.file
    console.log(
      `✓ downloaded ${spec} → ${relative(process.cwd(), got.file)} (${sizeOf(got.entry.bytes)}, sha256 ${got.entry.sha256.slice(0, 12)})`,
    )
  }
  const specRel = `./${relative(project.root, specAbs).split('\\').join('/')}`

  let servers: ServerEntry[] = []
  let creds: SpecCredentials = {
    profiles: [],
    secrets: [],
    notes: [],
    vars: {},
    environmentVars: {},
  }
  try {
    const doc = (await withPlainSpec(specAbs, (plain) =>
      SwaggerParser.parse(plain as string),
    )) as any
    // a server like `/api/v3` is relative to where the document came from, which is the address, not the downloaded file
    const source = isUrl(spec) ? spec : specAbs
    servers = openApiServers(doc, source).servers
    creds = credentialsFromSpec(doc, service, { source: isUrl(spec) ? spec : undefined, servers })
  } catch {
    /* an unreadable spec fails at generate, with a better message */
  }
  const variable = addressVariable(service)
  const live = baseUrl ?? servers.find((s) => s.name === 'live')?.url ?? ''

  let text = await readFile(project.configFile, 'utf8')
  const rel = relative(process.cwd(), project.configFile)
  // the credentials the spec asks for go in only when this config can take them: the service names a profile that exists
  const planned = planCredentials(text, creds, {
    secrets: project.config.secrets,
    auth: project.config.auth,
  })
  const writable = planned.profiles.length > 0 && applyCredentials(text, planned) !== undefined
  const plan = writable ? planned : { ...planned, profiles: [] }
  const entry = `    ${service}: {\n      spec: '${specRel}',\n      baseUrl: '{{${variable}}}',\n${plan.profiles.length ? `      auth: ${authValue(plan.profiles)},\n` : ''}    },\n`
  // the address, and the sign-in addresses the credentials written below read
  const wanted: [string, string][] = [
    [variable, live],
    ...(plan.profiles.length ? Object.entries(creds.vars) : []),
  ]
  let edited = false
  const m = /services\s*:\s*\{\s*\n/.exec(text)
  if (m) {
    text = text.slice(0, m.index + m[0].length) + entry + text.slice(m.index + m[0].length)
    // set on a line of its own or inside braces: the commented example `init` writes does not count
    const isSet = (name: string) => new RegExp(`(^|[{,])[ \\t]*${name}\\s*:`, 'm').test(text)
    const fresh = wanted.filter(([name]) => !isSet(name))
    for (const [name] of wanted)
      if (!fresh.some(([n]) => n === name))
        console.log(`  "${name}" is already in the config; left as it is`)
    const varLines = fresh.map(([name, value]) => `    ${name}: ${quote(value)},\n`).join('')
    const vars = /\bvars\s*:\s*\{[ \t]*\n?/.exec(text)
    if (!fresh.length) {
      /* nothing to add */
    } else if (vars) {
      text =
        text.slice(0, vars.index + vars[0].length).replace(/\{[ \t]*$/, '{\n') +
        varLines +
        text.slice(vars.index + vars[0].length)
    } else {
      const at = text.search(/\n\s*services\s*:/)
      text = `${text.slice(0, at)}\n  vars: {\n${varLines}  },${text.slice(at)}`
    }
    if (plan.profiles.length) text = applyCredentials(text, plan) as string
    await writeFile(project.configFile, text)
    edited = true
    console.log(`✓ added "${service}" to ${rel}`)
    reportCredentials(plan, creds)
  } else {
    console.log(
      `Could not edit the config automatically. Add this under vars:\n\n${wanted.map(([name, value]) => `    ${name}: ${quote(value)},\n`).join('')}\nand this under services:\n\n${entry}${credentialsHint(creds)}`,
    )
  }

  // each other server is the same variable in an environment file (and where a sign-in address differs, that too); a value
  // already there is kept
  const written: string[] = []
  const perEnvironment = new Map<string, [string, string][]>()
  for (const sv of servers.filter((x) => x.name !== 'live'))
    perEnvironment.set(sv.name, [[variable, sv.url]])
  if (plan.profiles.length)
    for (const [env, vars] of Object.entries(creds.environmentVars))
      perEnvironment.set(env, [...(perEnvironment.get(env) ?? []), ...Object.entries(vars)])
  for (const [env, entries] of perEnvironment) {
    const have = (await readEnvironment(project.root, env)).vars
    for (const [name, value] of entries) {
      if (have[name] !== undefined) continue
      await ensureEnvironmentsDir(project.root)
      await writeEnvKey(varsFile(project.root, env), name, value)
      written.push(`  ${env}.env  ${name}=${value}`)
    }
  }
  if (edited && !live)
    console.log(`  the spec lists no server: set ${variable} in the config or an environment file`)
  if (written.length) {
    console.log(`✓ other servers became environments in .specbook/environments/:`)
    for (const line of written) console.log(line)
  }

  const out = await generateToDisk({
    spec: specAbs,
    service,
    outDir: resolve(project.root, project.config.codegen?.outDir ?? '.generated'),
  })
  console.log(`✓ ${service}: ${out.operations.length} operations → ${out.root}`)
}
