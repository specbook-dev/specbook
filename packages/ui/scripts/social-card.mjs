#!/usr/bin/env node
// Renders the preview cards: `landing/og.png` (1200x630, the link preview on Reddit, X, Slack) and
// `../../.github/social-preview.png` (1280x640, GitHub's repository card).
//
//   node scripts/social-card.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const icon = readFileSync(resolve(here, '../landing/favicon.svg'), 'utf8').replace(
  '<svg ',
  '<svg width="200" height="200" ',
)

const html = (w, h) => `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: ${w}px; height: ${h}px; display: flex; align-items: center;
    padding: 0 ${Math.round(w * 0.075)}px; gap: 56px; color: #f4f5f8;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    background: radial-gradient(1200px 600px at 0% 0%, #2b1a52 0%, #14111f 55%, #0d0c14 100%); }
  .mark { flex: none; filter: drop-shadow(0 18px 40px rgba(109, 40, 217, 0.45)); }
  h1 { margin: 0; font-size: 104px; letter-spacing: -0.03em; line-height: 1; }
  .tag { margin-top: 14px; font-size: 46px; font-weight: 650; color: #b79cff; }
  .line { margin-top: 26px; font-size: 30px; line-height: 1.35; color: #c3c7d4; max-width: 640px; }
  .url { position: absolute; right: ${Math.round(w * 0.075)}px; bottom: 40px; font-size: 26px; color: #8e94a6; }
</style><body><div class="mark">${icon}</div><div>
  <h1>Specbook</h1><div class="tag">Same spec. Way more swagger.</div>
  <div class="line">Storybook for APIs. Open any OpenAPI or Swagger spec: mocks from the first request, live calls when you say so.</div>
</div><div class="url">ui.specbook.dev</div></body>`

const out = [
  [1200, 630, resolve(here, '../landing/og.png')],
  [1280, 640, resolve(here, '../../../.github/social-preview.png')],
]
const browser = await chromium.launch()
for (const [w, h, file] of out) {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  await page.setContent(html(w, h))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, await page.screenshot({ type: 'png' }))
  await page.close()
  console.log(`${file} (${w}x${h})`)
}
await browser.close()
