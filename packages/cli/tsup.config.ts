import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/bin.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  clean: true,
  noExternal: [/^@specbook\//],
  external: ['vite', 'vite-node', 'fast-glob', '@apidevtools/swagger-parser', 'swagger2openapi'],
})
