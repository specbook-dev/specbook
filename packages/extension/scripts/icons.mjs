// Renders the extension's icons from the site's own favicon, once, with Chromium: `pnpm --filter
// @specbook/extension icons`. The PNGs are committed, so a build does not need a browser.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const svg = await readFile(resolve(here, '../../ui/landing/favicon.svg'), 'utf8')
const out = resolve(here, '../icons')
await mkdir(out, { recursive: true })
const browser = await chromium.launch()
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    await page.setContent(
      `<body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${svg.replace(
        /<svg /,
        `<svg width="${size}" height="${size}" `,
      )}</div></body>`,
    )
    await writeFile(join(out, `${size}.png`), await page.screenshot({ omitBackground: true }))
    await page.close()
  }
} finally {
  await browser.close()
}
