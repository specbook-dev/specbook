import { defineConfig } from 'vitest/config'

// The built viewer (`dist-viewer`) driven in a real browser by Playwright; see `pnpm test:viewer`.
export default defineConfig({
  test: { include: ['test/viewer/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 60_000 },
})
