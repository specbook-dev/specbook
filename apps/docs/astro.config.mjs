import preact from '@astrojs/preact'
import sitemap from '@astrojs/sitemap'
import starlight from '@astrojs/starlight'
import { defineConfig, passthroughImageService } from 'astro/config'
import { artifacts } from './integrations/artifacts.mjs'

// The copied builds (the full example at /demo/, the QA portal at /qa/, the viewer at /viewer/) are separate apps, not pages
const NOT_PAGES = ['/demo/', '/qa/', '/viewer/']

export default defineConfig({
  site: 'https://docs.specbook.dev',
  trailingSlash: 'always',
  // no sharp: the site has no raster pipeline, and the Open Graph images are committed
  image: { service: passthroughImageService() },
  build: {
    // every script and style is a file, so the site's policy needs no 'unsafe-inline' for them
    inlineStylesheets: 'never',
  },
  vite: {
    build: { assetsInlineLimit: 0 },
    // the terminal runs the real runner, which asserts with uvu. Left to be found while the page loads, the dev server
    // rebuilds its dependencies mid-load and the terminal fails to start; named here, it does not.
    optimizeDeps: { include: ['@specbook/core > uvu/assert'] },
  },
  integrations: [
    starlight({
      title: 'Specbook',
      description:
        'The Swagger UI alternative built for modern teams: explore APIs, author executable flows once, publish live documentation.',
      disable404Route: true,
      // Reference pages share the home card: a link to one in a post or a chat shows a picture too
      head: [
        {
          tag: 'meta',
          attrs: { property: 'og:image', content: 'https://docs.specbook.dev/og/home.png' },
        },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        {
          tag: 'meta',
          attrs: { property: 'og:image:alt', content: 'Specbook: API docs that come to life' },
        },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
      ],
      pagefind: true,
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/specbook-dev/specbook' },
      ],
      customCss: ['./src/styles/site.css', './src/styles/starlight.css'],
      sidebar: [{ label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] }],
      components: { ThemeProvider: './src/components/StarlightThemeProvider.astro' },
    }),
    preact(),
    sitemap({ filter: (page) => !NOT_PAGES.some((p) => new URL(page).pathname.startsWith(p)) }),
    artifacts(),
  ],
})
