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
  vite: { build: { assetsInlineLimit: 0 } },
  integrations: [
    starlight({
      title: 'Specbook',
      description:
        'The Swagger UI alternative built for modern teams: explore APIs, author executable flows once, publish live documentation.',
      disable404Route: true,
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
