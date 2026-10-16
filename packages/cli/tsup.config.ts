import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/bin.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node18',
    clean: true,
    noExternal: [/^@specbook\//],
    external: [
      'vite',
      'vite-node',
      'rolldown',
      'fast-glob',
      '@apidevtools/swagger-parser',
      'swagger2openapi',
    ],
  },
  {
    // the runner a bundle is built around: it shares the one copy of core that `specbook bundle` hands to the requests
    entry: ['src/standalone.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node18',
    clean: false,
    external: [/^@specbook\/core/],
  },
])
