// Builds the service worker (the demo API) into one small file for the docs site: dist-sw/sw.js.
import { mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(join(root, 'dist-sw'), { recursive: true })
await build({
  entryPoints: [join(root, 'server/sw.ts')],
  outfile: join(root, 'dist-sw/sw.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  platform: 'browser',
  // `#api/petstore` is only types here, but esbuild still has to resolve the import
  conditions: ['import'],
  logLevel: 'warning',
})
const size = (await stat(join(root, 'dist-sw/sw.js'))).size
console.log(`✓ dist-sw/sw.js ${(size / 1024).toFixed(1)} KB`)
