import { readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import SwaggerParser from '@apidevtools/swagger-parser'
import { generateToDisk, withPlainSpec } from '@specbook/codegen'
import { openApiServers, type ServerEntry } from '@specbook/core'
import { ensureEnvironmentsDir, readEnvironment, varsFile, writeEnvKey } from '@specbook/vite'
import type { Project } from '../project'
import { fetchSpec, isUrl, sizeOf } from './spec-source'

/** `petstore` → `petstoreUrl`, `my-api` → `myApiUrl`: the variable a service's address is kept in. */
export const addressVariable = (service: string) =>
  `${service.replace(/[-_]+(.)/g, (_, c: string) => c.toUpperCase())}Url`

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

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
  try {
    servers = openApiServers(
      (await withPlainSpec(specAbs, (plain) => SwaggerParser.parse(plain as string))) as any,
      // a server like `/api/v3` is relative to where the document came from, which is the address, not the downloaded file
      isUrl(spec) ? spec : specAbs,
    ).servers
  } catch {
    /* an unreadable spec fails at generate, with a better message */
  }
  const variable = addressVariable(service)
  const live = baseUrl ?? servers.find((s) => s.name === 'live')?.url ?? ''

  let text = await readFile(project.configFile, 'utf8')
  const rel = relative(process.cwd(), project.configFile)
  const entry = `    ${service}: {\n      spec: '${specRel}',\n      baseUrl: '{{${variable}}}',\n    },\n`
  const varLine = `    ${variable}: ${quote(live)},\n`
  let edited = false
  const m = /services\s*:\s*\{\s*\n/.exec(text)
  if (m) {
    text = text.slice(0, m.index + m[0].length) + entry + text.slice(m.index + m[0].length)
    // set on a line of its own or inside braces: the commented example `init` writes does not count
    const have = new RegExp(`(^|[{,])[ \\t]*${variable}\\s*:`, 'm').test(text)
    const vars = /\bvars\s*:\s*\{[ \t]*\n?/.exec(text)
    if (have) {
      console.log(`  "${variable}" is already in the config; left as it is`)
    } else if (vars) {
      text =
        text.slice(0, vars.index + vars[0].length).replace(/\{[ \t]*$/, '{\n') +
        varLine +
        text.slice(vars.index + vars[0].length)
    } else {
      const at = text.search(/\n\s*services\s*:/)
      text = `${text.slice(0, at)}\n  vars: {\n${varLine}  },${text.slice(at)}`
    }
    await writeFile(project.configFile, text)
    edited = true
    console.log(`✓ added "${service}" to ${rel}`)
  } else {
    console.log(
      `Could not edit the config automatically. Add this under vars:\n\n${varLine}\nand this under services:\n\n${entry}`,
    )
  }

  // each other server is the same variable in an environment file; a value already there is kept
  const written: string[] = []
  for (const s of servers.filter((x) => x.name !== 'live')) {
    if ((await readEnvironment(project.root, s.name)).vars[variable] !== undefined) continue
    await ensureEnvironmentsDir(project.root)
    await writeEnvKey(varsFile(project.root, s.name), variable, s.url)
    written.push(`  ${s.name}.env  ${variable}=${s.url}`)
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
