import type { Plugin } from 'vite'

/**
 * Stands in for the generated `#api/<service>` modules in a test project that has no spec: each operation is
 * a `defineOperation` of the metadata given, which is all a run needs of one.
 */
export function fakeApi(services: Record<string, Record<string, unknown>>): Plugin {
  const VIRTUAL = '\0fake-api:'
  return {
    name: 'fake-api',
    enforce: 'pre',
    resolveId(id) {
      return id.startsWith('#api/') ? `${VIRTUAL}${id.slice(5)}` : undefined
    },
    load(id) {
      if (!id.startsWith(VIRTUAL)) return undefined
      const metas = services[id.slice(VIRTUAL.length)] ?? {}
      return [
        "import { defineOperation } from '@specbook/core'",
        ...Object.entries(metas).map(
          ([opId, meta]) => `export const ${opId} = defineOperation(${JSON.stringify(meta)})`,
        ),
      ].join('\n')
    },
  }
}
