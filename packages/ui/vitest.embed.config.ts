import { defineConfig } from 'vitest/config'

// The embed (`specbook.js` of a project build) on a page served under a strict Content-Security-Policy, driven by Playwright;
// see `pnpm test:embed`. It builds a small project with the CLI first, so the CLI is built before it runs.
export default defineConfig({
  test: {
    include: ['test/embed-static/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
})
