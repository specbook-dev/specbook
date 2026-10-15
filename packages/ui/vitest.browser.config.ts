import { resolve } from 'node:path'
import { specbook } from '@specbook/vite'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

// Runs the real UI/runtime in Chromium against the example project, using the same Vite plugin
// the dev server uses. Catches module-loading problems (JSON, CJS, import queries) that Node can't.
const project = resolve(import.meta.dirname, '../../apps/example')

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  plugins: [specbook({ projectRoot: project })],
  // A test run never needs file watching, and an edit made just before the run would otherwise
  // arrive after startup as a change, reload the page mid-test and drop the browser connection.
  server: { fs: { allow: [resolve(import.meta.dirname, '../..')] }, watch: null },
  // Pre-declare every dependency so Vite never re-optimizes (and reloads the page) mid-run.
  optimizeDeps: {
    exclude: ['@specbook/core'],
    include: [
      '@specbook/core > uvu/assert',
      '@faker-js/faker',
      'preact',
      'preact/hooks',
      'preact/jsx-dev-runtime',
      '@preact/signals',
      'prism-code-editor',
      'prism-code-editor/commands',
      'prism-code-editor/autocomplete',
      'prism-code-editor/cursor',
      'prism-code-editor/languages/json',
      'prism-code-editor/languages/graphql',
      'prism-code-editor/prism/languages/json',
      'prism-code-editor/prism/languages/graphql',
    ],
  },
  test: {
    include: ['test/browser/**/*.test.{ts,tsx}'],
    // several files share one browser and the machine; the waits inside a test (30 s for a panel to open)
    // are meant to be the limit, so the test's own timeout must not be shorter than they are
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // On a runner, name each test as it finishes: a run that stalls then ends its log on the last test that
    // completed, and the one after it is the one that hung. (The annotations reporter is kept.)
    reporters: process.env.GITHUB_ACTIONS ? ['verbose', 'github-actions'] : ['default'],
    // One test file in the browser at a time. Run side by side, the heavy ones (the whole registry, the
    // GitHub and Stripe specs) starve each other on a two core runner, and a page that stops answering
    // closes the connection for the whole run ("Browser connection was closed while running tests").
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
})
