import { copyFile, cp, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { specbook } from '@specbook/vite'
import { build, createServer, type InlineConfig } from 'vite'
import type { Project } from '../project'

function uiRoot(): string {
  const require = createRequire(import.meta.url)
  return dirname(require.resolve('@specbook/ui/package.json'))
}

function uiConfig(project: Project): InlineConfig {
  const root = uiRoot()
  return {
    root,
    configFile: false,
    // set here, not left to the nearest tsconfig: an installed @specbook/ui has none, and the dependency scan
    // would then look for `react/jsx-dev-runtime`
    oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
    optimizeDeps: {
      exclude: ['@specbook/core'],
      rolldownOptions: { transform: { jsx: { runtime: 'automatic', importSource: 'preact' } } },
    },
    plugins: [specbook({ projectRoot: project.root, outDir: project.config.codegen?.outDir })],
    server: { fs: { allow: [resolve(root, '../..'), project.root, resolve(root, '..')] } },
  }
}

export async function devCommand(project: Project, port = 5173) {
  const server = await createServer({
    ...uiConfig(project),
    server: { ...uiConfig(project).server, port },
  })
  await server.listen()
  server.printUrls()
  return server
}

export async function buildCommand(project: Project, outDir: string): Promise<void> {
  const out = resolve(project.root, outDir)
  // One build, two entries, so the lazy chunks are shared: the docs app (index.html) and the embeddable
  // `specbook.js` (`<script type="module" src=".../specbook.js">`), which loads its chunks relative to itself.
  await build({
    ...uiConfig(project),
    base: './',
    build: {
      outDir: out,
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(uiRoot(), 'index.html'),
          specbook: resolve(uiRoot(), 'src/embed.ts'),
        },
        preserveEntrySignatures: 'exports-only',
        output: {
          entryFileNames: (chunk) =>
            chunk.name === 'specbook' ? 'specbook.js' : 'assets/[name]-[hash].js',
        },
      },
    },
  })
  await copyFile(
    join(project.root, project.config.codegen?.outDir ?? '.generated', 'specbook.json'),
    join(out, 'specbook.json'),
  ).catch(() => {})
}

/**
 * Copies the prebuilt spec viewer into `<out>/viewer/`, for teams that serve it themselves (same origin as
 * their API, or air-gapped). The viewer is built once when specbook is released, not per project.
 */
export async function copyViewer(
  project: Project,
  outDir: string,
  viewerDir = resolve(uiRoot(), 'dist-viewer'),
): Promise<string> {
  const has = await stat(join(viewerDir, 'index.html')).then(
    () => true,
    () => false,
  )
  if (!has)
    throw new Error(
      `The viewer is not built (looked in ${viewerDir}). Run \`pnpm --filter @specbook/ui build:viewer\` first.`,
    )
  const dest = resolve(project.root, outDir, 'viewer')
  await cp(viewerDir, dest, { recursive: true })
  return dest
}
