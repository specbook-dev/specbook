#!/usr/bin/env node
// Renders `landing/screenshot.png`, the picture on the landing page and in the README: the hosted viewer
// with the Petstore spec open and a mock request sent. Needs the viewer built (`pnpm build:viewer`).
//
//   node scripts/screenshot.mjs [--op <service/Operation>] [--theme light|dark] [--mobile] [--out <file>]
//   node scripts/screenshot.mjs --pair [--theme light|dark]
//
// `--pair` joins the laptop and phone pictures already in `landing/` into one image for the README (written
// to `.github/`, so the site build does not ship it): two separate images would wrap on a narrow screen,
// one image just scales.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : fallback
}
const op = arg('op', 'swagger-petstore-openapi-3-0/PlaceOrder')
const theme = arg('theme', 'light')
const mobile = process.argv.includes('--mobile')
const name = `screenshot${mobile ? '-mobile' : ''}${theme === 'dark' ? '-dark' : ''}.png`
const out = resolve(arg('out', join(here, '../landing', name)))
const specFile = resolve(here, '../../codegen/test/fixtures/petstore3.json')
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
}

if (process.argv.includes('--pair')) {
  const suffix = theme === 'dark' ? '-dark' : ''
  const read = (f) =>
    `data:image/png;base64,${readFileSync(join(here, '../landing', f)).toString('base64')}`
  const wide = read(`screenshot${suffix}.png`)
  const phone = read(`screenshot-mobile${suffix}.png`)
  // both pictures at one height: the laptop one is 2560x1520, the phone one 1170x2532, halved for the page
  const H = 760
  const phoneW = Math.round((H * 1170) / 2532)
  const wideW = Math.round((H * 2560) / 1520)
  const gap = 24
  const W = wideW + gap + phoneW
  const pair = resolve(arg('out', join(here, '../../../.github', `screenshot-pair${suffix}.png`)))
  const html = `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; background: transparent; }
    body { width: ${W}px; height: ${H}px; display: flex; gap: ${gap}px; }
    img { height: ${H}px; border-radius: 10px; box-shadow: 0 0 0 1px ${theme === 'dark' ? '#2a2f3a' : '#d9dde4'}; }
  </style><body><img src="${wide}" width="${wideW}"><img src="${phone}" width="${phoneW}"></body>`
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  await page.setContent(html)
  await page.waitForFunction(() => [...document.images].every((i) => i.complete))
  writeFileSync(pair, await page.screenshot({ type: 'png', omitBackground: true }))
  await browser.close()
  console.log(`${pair} (${W}x${H}, ${theme})`)
  process.exit(0)
}

const dist = await mkdtemp(join(tmpdir(), 'sb-shot-'))
execFileSync('node', [resolve(here, 'assemble-site.mjs'), '--out', dist], { stdio: 'ignore' })

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)))
const site = createServer(async (req, res) => {
  const p = new URL(req.url ?? '/', 'http://x').pathname
  try {
    if (p === '/petstore3.json') {
      res.setHeader('content-type', 'application/json')
      return void res.end(await readFile(specFile))
    }
    const f = join(dist, p.endsWith('/') ? `${p}index.html` : p)
    res.setHeader('content-type', types[extname(f)] ?? 'application/octet-stream')
    res.end(await readFile(f))
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
})
const port = await listen(site)
const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 760 },
    deviceScaleFactor: mobile ? 3 : 2,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: theme,
  })
  await page.goto(
    `http://127.0.0.1:${port}/v1/?spec=${encodeURIComponent(`http://127.0.0.1:${port}/petstore3.json`)}`,
  )
  await page.waitForSelector('.op-row', { state: 'attached', timeout: 30_000 })
  await page.evaluate((k) => {
    location.hash = `#/op/${encodeURIComponent(k)}`
  }, op)
  await page.waitForSelector('.request-panel .rq-bar', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Send' }).click()
  await page.waitForSelector('.result-chip:has-text("200")', { timeout: 20_000 })
  await page
    .getByText('Response', { exact: false })
    .filter({ hasText: /^Response/ })
    .first()
    .click()
  await page.waitForTimeout(500)
  await writeFile(out, await page.screenshot({ type: 'png' }))
  console.log(`${out} (${mobile ? '390x844 @3x' : '1280x760 @2x'}, ${theme})`)
} finally {
  await browser.close()
  site.close()
  await rm(dist, { recursive: true, force: true })
}
