import { copyFile, cp, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { specbook } from '@specbook/vite'
import { build, createServer, type InlineConfig } from 'vite'
import { usedOperationKeys } from '../ops'
import type { Project } from '../project'

function uiRoot(): string {
  const require = createRequire(import.meta.url)
  return dirname(require.resolve('@specbook/ui/package.json'))
}

/** The `node_modules` folder a resolved file sits in (the innermost one), or undefined outside any. */
export function nodeModulesOf(file: string): string | undefined {
  const marker = `${sep}node_modules`
  const at = file.lastIndexOf(`${marker}${sep}`)
  return at < 0 ? undefined : file.slice(0, at + marker.length)
}

/** Every `node_modules` folder a file is inside, innermost first. */
export function enclosingNodeModules(file: string): string[] {
  const out: string[] = []
  for (let dir = dirname(file); dirname(dir) !== dir; dir = dirname(dir))
    if (basename(dir) === 'node_modules') out.push(dir)
  return out
}

/**
 * Where the dev server may serve files from. A package installed by `npx` can sit in one `node_modules` while
 * its dependencies (the editor's stylesheets, vite's client) are hoisted to another, or the CLI can be linked
 * in from a checkout: every `node_modules` this CLI and the UI sit in, and the one each dependency the page
 * loads from disk resolves into, is a place it may serve from.
 */
function dependencyFolders(root: string): string[] {
  const found = new Set<string>([
    ...enclosingNodeModules(fileURLToPath(import.meta.url)),
    ...enclosingNodeModules(join(root, 'package.json')),
  ])
  for (const from of [join(root, 'package.json'), fileURLToPath(import.meta.url)]) {
    const require = createRequire(from)
    for (const name of ['vite', 'prism-code-editor', 'preact', '@preact/signals']) {
      try {
        const folder = nodeModulesOf(require.resolve(name))
        if (folder) found.add(folder)
      } catch {
        /* not resolvable from here: the others still are */
      }
    }
  }
  return [...found]
}

function uiConfig(project: Project, operations?: Set<string>): InlineConfig {
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
    plugins: [
      specbook({ projectRoot: project.root, outDir: project.config.codegen?.outDir, operations }),
    ],
    server: {
      fs: {
        allow: [
          resolve(root, '../..'),
          project.root,
          resolve(root, '..'),
          ...dependencyFolders(root),
        ],
      },
    },
  }
}

export async function devCommand(project: Project, port = 5173) {
  const server = await createServer({
    ...uiConfig(project),
    server: { ...uiConfig(project).server, port },
  })
  await server.listen()
  server.printUrls()
  // a provider only sends the person back to an address it was told about: say which one this is
  const signIn = Object.entries(project.config.auth ?? {}).filter(([, p]) => p.oauth)
  const url = server.resolvedUrls?.local[0]
  if (signIn.length && url) {
    console.log(
      `  OAuth redirect URI to register for ${signIn.map(([n]) => n).join(', ')}: ${url}\n` +
        '  (it follows the port; pass --port to keep it the same between runs)',
    )
  }
  return server
}

/**
 * Builds the portal. `minimal` publishes only the operations the project's requests and flows use, with those requests and
 * flows: a smaller site that does not reveal the rest of the API.
 */
export async function buildCommand(
  project: Project,
  outDir: string,
  options: { minimal?: boolean } = {},
): Promise<void> {
  const out = resolve(project.root, outDir)
  const generated = join(project.root, project.config.codegen?.outDir ?? '.generated')
  const operations = options.minimal ? await usedOperationKeys(project, generated) : undefined
  if (operations && operations.size === 0)
    throw new Error('Nothing to publish: no request or flow imports an operation (see --minimal)')
  // One build, two entries, so the lazy chunks are shared: the docs app (index.html) and the embeddable
  // `specbook.js` (`<script type="module" src=".../specbook.js">`), which loads its chunks relative to itself.
  await build({
    ...uiConfig(project, operations),
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
  await copyMetadata(join(generated, 'specbook.json'), join(out, 'specbook.json'), operations)
}

/** `specbook.json` lists every operation of the spec: a minimal build lists only the ones it publishes. */
async function copyMetadata(from: string, to: string, operations?: Set<string>): Promise<void> {
  try {
    if (!operations) return await copyFile(from, to)
    const meta = JSON.parse(await readFile(from, 'utf8')) as {
      services: Record<string, { operations: Record<string, unknown> }>
    }
    for (const [svc, s] of Object.entries(meta.services)) {
      s.operations = Object.fromEntries(
        Object.entries(s.operations).filter(([id]) => operations.has(`${svc}/${id}`)),
      )
      if (Object.keys(s.operations).length === 0) delete meta.services[svc]
    }
    await writeFile(to, `${JSON.stringify(meta)}\n`)
  } catch {
    /* a project without generated metadata still builds */
  }
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
