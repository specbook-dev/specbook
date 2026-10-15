import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  clean: true,
  noExternal: [/^@specbook\//],
  external: ['vite', 'fast-glob'],
})
