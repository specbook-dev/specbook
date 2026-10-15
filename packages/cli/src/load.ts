import { createServer } from 'vite'
import { ViteNodeRunner } from 'vite-node/client'
import { ViteNodeServer } from 'vite-node/server'
import { installSourcemapsSupport } from 'vite-node/source-map'

export interface Loader {
  import<T = Record<string, unknown>>(file: string): Promise<T>
  close(): Promise<void>
}

/** Loads TS/JSON project files through Vite, so resolution matches the UI (subpath imports, JSON, etc.). */
export async function createLoader(root: string): Promise<Loader> {
  const server = await createServer({
    root,
    logLevel: 'silent',
    configFile: false,
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  await server.pluginContainer.buildStart({})
  const node = new ViteNodeServer(server)
  installSourcemapsSupport({ getSourceMap: (source) => node.getSourceMap(source) })
  const runner = new ViteNodeRunner({
    root: server.config.root,
    base: server.config.base,
    fetchModule: (id) => node.fetchModule(id),
    resolveId: (id, importer) => node.resolveId(id, importer),
  })
  return {
    import: (file) => runner.executeFile(file) as Promise<never>,
    close: () => server.close(),
  }
}
