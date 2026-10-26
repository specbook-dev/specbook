import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/internal.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  clean: true,
  noExternal: [/^@specbook\//],
  external: ['vite', 'fast-glob'],
})
