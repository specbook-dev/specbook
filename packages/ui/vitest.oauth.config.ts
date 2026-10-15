import { defineConfig } from 'vitest/config'

// Sign-in against a real Keycloak. Not part of `pnpm test` or CI: it needs Docker (test/oauth/keycloak.sh).
export default defineConfig({
  test: {
    include: ['test/oauth/**/*.test.ts'],
    // a preview server generates and starts before the first page opens
    testTimeout: 120_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
})
