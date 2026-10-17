#!/usr/bin/env node
// Renders the link-preview card for each page into `public/og/` (1200x630, committed; the site does not render them at
// build). Run after changing a page's name or line:  node scripts/og.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const icon = readFileSync(resolve(root, 'public/favicon.svg'), 'utf8').replace(
  '<svg ',
  '<svg width="120" height="120" ',
)
const pages = readFileSync(resolve(root, 'src/lib/pages.ts'), 'utf8')
const found = [...pages.matchAll(/slug: '([a-z]+)',\s+name: '([^']+)',\s+line: '([^']+)'/g)].map(
  (m) => ({
    slug: m[1],
    name: m[2],
    line: m[3],
  }),
)

export const CARDS = [
  {
    slug: 'home',
    name: 'Specbook',
    line: 'One definition, from discovery and development to QA and production monitoring.',
  },
  ...found,
]

const html = (c) => `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: 1200px; height: 630px; padding: 0 90px; display: flex; flex-direction: column; justify-content: center;
    gap: 28px; color: #f4f5f8; position: relative;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    background: radial-gradient(1100px 560px at 0% 0%, #2b1a52 0%, #14111f 55%, #0d0c14 100%); }
  h1 { margin: 0; font-size: 112px; letter-spacing: -0.03em; line-height: 1; }
  p { margin: 0; font-size: 40px; line-height: 1.3; color: #c3c7d4; max-width: 880px; }
  .brand { display: flex; align-items: center; gap: 20px; font-size: 34px; color: #b79cff; font-weight: 650; }
  .url { position: absolute; right: 90px; bottom: 44px; font-size: 26px; color: #8e94a6; }
</style><body><div class="brand">${icon}<span>Specbook</span></div>
  <h1>${c.slug === 'home' ? 'Same spec. Way more swagger.' : c.name}</h1><p>${c.line}</p>
<div class="url">docs.specbook.dev</div></body>`

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(resolve(root, 'public/og'), { recursive: true })
  const browser = await chromium.launch()
  for (const c of CARDS) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } })
    await page.setContent(html(c))
    writeFileSync(resolve(root, `public/og/${c.slug}.png`), await page.screenshot({ type: 'png' }))
    await page.close()
    console.log(`public/og/${c.slug}.png`)
  }
  await browser.close()
}
