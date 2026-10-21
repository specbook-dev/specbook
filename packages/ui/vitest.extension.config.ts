import { defineConfig } from 'vitest/config'

// The real extension, loaded into Chromium, in front of the real viewer. Not part of `pnpm test`.
export default defineConfig({
  test: {
    include: ['test/extension/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
