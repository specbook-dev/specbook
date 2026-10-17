import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Which operation a request file is for, read from its text without importing it:
 * `import { GetPetById } from '#api/petstore'` and `GetPetById.request({...})` make `petstore/GetPetById`. The panel of an
 * embed opens one request, and with this it imports that file instead of every request in the project.
 *
 * `services` are the project's service names; an import counts when the last segment of its address is one of them, so any
 * import prefix works. Anything the text does not settle (no call, two different operations, a computed one) is undefined,
 * and the file is then imported when requests are listed.
 */
export function parseRequestTarget(src: string, services: ReadonlySet<string>): string | undefined {
  const local = new Map<string, string>()
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const service = (m[2] as string).split('/').pop() as string
    if (!services.has(service) || /^import\s*type/.test(m[0])) continue
    for (const part of (m[1] as string).split(',')) {
      const spec = part.trim()
      if (!spec || spec.startsWith('type ')) continue
      const [imported, as] = spec.split(/\s+as\s+/)
      local.set((as ?? imported) as string, `${service}/${imported}`)
    }
  }
  const used = new Set<string>()
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*request\s*\(/g)) {
    const key = local.get(m[1] as string)
    if (key) used.add(key)
  }
  return used.size === 1 ? [...used][0] : undefined
}

export interface RequestScan {
  /** project-relative request file → `service/Operation` */
  meta: Record<string, string>
  /** files the text does not settle; the UI imports these */
  unresolved: string[]
}

export async function scanRequests(
  root: string,
  files: string[],
  services: ReadonlySet<string>,
): Promise<RequestScan> {
  const meta: Record<string, string> = {}
  const unresolved: string[] = []
  await Promise.all(
    files.map(async (file) => {
      const key = parseRequestTarget(
        await readFile(join(root, file), 'utf8').catch(() => ''),
        services,
      )
      if (key) meta[file] = key
      else unresolved.push(file)
    }),
  )
  return { meta, unresolved: unresolved.sort() }
}
