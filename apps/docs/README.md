# apps/docs

The documentation site, docs.specbook.dev: a landing page and four more (Develop, Document, Test, Monitor) whose demos run in the
page, plus a Starlight Reference section. Every block of code is read from a file that CI compiles and runs.

```bash
pnpm build:site     # builds the demos and the viewer, then the site into apps/docs/dist
pnpm test:site      # drives the built site in Chromium, served with its own _headers
pnpm --filter docs dev
```

- `demo/` is the project the pages run: a Hono API that is a service worker (`server/`), requests and flows, and a
  specbook config. Its own tests are under `demo/test`.
- `snippets/` holds the code that has no other home (install commands, workflows, theme CSS). A page names a file and a
  `#region`; a name that does not exist fails the build.
- `integrations/artifacts.mjs` copies the example's full build to `/demo/`, the demo's minimal build to `/qa/` (its
  `specbook.js` is the play popover on every page), the viewer to `/viewer/`, and the service worker, and writes
  `_headers`.
- `scripts/check-site.mjs` fails the build near Cloudflare Pages' limits (files, file size, total, home page scripts).
- `scripts/og.mjs` renders `public/og/*.png`; commit them after changing a page's name or line.
- `.astro` files are not type-checked: `astro check` does not support TypeScript 7 yet. `pnpm typecheck` covers the `.ts`.
