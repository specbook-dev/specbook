import { defineConfig } from 'vitest/config'

// Node unit tests only; browser-mode tests live in test/browser (see vitest.browser.config.ts).
export default defineConfig({
  test: { include: ['test/*.test.ts'] },
})
