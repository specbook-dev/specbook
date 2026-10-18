import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { noticesPlugins } from './scripts/third-party-notices.mjs'

const here = import.meta.dirname
const notices = noticesPlugins()
const stub = resolve(here, 'viewer/node-stub.js')
// swagger2openapi reaches for Node modules it never uses for an in-memory document
const node = [
  'fs',
  'path',
  'url',
  'http',
  'https',
  'util',
  'os',
  'stream',
  'zlib',
  'assert',
  'events',
  'buffer',
  'querystring',
  'tty',
  'crypto',
  'child_process',
  'net',
  'tls',
  'node-fetch-h2',
]

/**
 * The viewer: the same app, with `virtual:specbook/registry` answered by a spec the person opens at run
 * time instead of a project on disk. Output is `dist-viewer`, built with relative URLs so one build
 * serves `/v1/`, an exact release path, a webjar and `specbook build --viewer`.
 */
export default defineConfig({
  root: resolve(here, 'viewer'),
  base: './',
  publicDir: resolve(here, 'viewer/public'),
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  resolve: {
    alias: [
      { find: 'virtual:specbook/registry', replacement: resolve(here, 'src/viewer/registry.ts') },
      // a built project fills its manifests from this; the viewer's registry already has its one
      { find: 'virtual:specbook/manifests', replacement: resolve(here, 'src/viewer/manifests.ts') },
      ...node.flatMap((n) => [
        { find: new RegExp(`^${n}$`), replacement: stub },
        { find: new RegExp(`^node:${n}$`), replacement: stub },
      ]),
    ],
  },
  define: { 'process.env': '{}', 'process.platform': '"browser"', 'process.version': '"v0"' },
  // the worker is built on its own: its packages are recorded too, then written out with the main build's
  worker: { format: 'es', plugins: () => [notices.collect] },
  plugins: [notices.emit],
  build: {
    outDir: resolve(here, 'dist-viewer'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      // two entries over shared chunks: the viewer page, and `specbook.js` for a host page to load
      input: {
        index: resolve(here, 'viewer/index.html'),
        specbook: resolve(here, 'src/viewer/embed.ts'),
      },
      preserveEntrySignatures: 'exports-only',
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'specbook' ? 'specbook.js' : 'assets/[name]-[hash].js',
      },
    },
  },
})
