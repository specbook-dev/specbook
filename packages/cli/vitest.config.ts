import { configDefaults, defineConfig } from 'vitest/config'

// `*.slow.test.ts` do a full site build; they run with `pnpm test:slow` (see vitest.slow.config.ts)
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/*.slow.test.ts'] },
})
