import { readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { generateToDisk } from '@specbook/codegen'
import type { Project } from '../project'

/** Registers a service in the config file (text edit) and generates its code. */
export async function addCommand(
  project: Project,
  service: string,
  spec: string,
  baseUrl?: string,
) {
  if (!/^[A-Za-z][\w-]*$/.test(service)) throw new Error(`Invalid service name "${service}"`)
  if (project.config.services[service])
    throw new Error(`Service "${service}" already exists in the config`)
  const specAbs = resolve(process.cwd(), spec)
  const specRel = `./${relative(project.root, specAbs).split('\\').join('/')}`

  const text = await readFile(project.configFile, 'utf8')
  const entry = `    ${service}: {\n      spec: '${specRel}',\n      baseUrl: { live: '${baseUrl ?? ''}' },\n    },\n`
  const m = /services\s*:\s*\{\s*\n/.exec(text)
  if (m) {
    await writeFile(
      project.configFile,
      text.slice(0, m.index + m[0].length) + entry + text.slice(m.index + m[0].length),
    )
    console.log(`✓ added "${service}" to ${relative(process.cwd(), project.configFile)}`)
  } else {
    console.log(`Could not edit the config automatically. Add this under services:\n\n${entry}`)
  }
  const out = await generateToDisk({
    spec: specAbs,
    service,
    outDir: resolve(project.root, project.config.codegen?.outDir ?? '.generated'),
  })
  console.log(`✓ ${service}: ${out.operations.length} operations → ${out.root}`)
}
