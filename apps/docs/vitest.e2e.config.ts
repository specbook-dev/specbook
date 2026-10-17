import { defineConfig } from 'vitest/config'

// The built site, served with its own headers and driven in Chromium; see `pnpm test:site`.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
