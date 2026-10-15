import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createNet } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { BrowserContext, Page } from 'playwright'
import { assembleSite, siteHandler } from './site'

const cli = resolve(import.meta.dirname, '../../../cli/dist/bin.js')

/** A port nothing is listening on. The pages' origins go into the realm, so they are chosen per run. */
export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createNet()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitForHttp(url: string, child: ChildProcess, output: () => string, ms = 120_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (child.exitCode !== null)
      throw new Error(`specbook preview exited (${child.exitCode}):\n${output()}`)
    try {
      if ((await fetch(url)).ok) return
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error(`specbook preview did not answer at ${url}:\n${output()}`)
}

/** `specbook preview <file>` as a real child process: the dev server and its credential proxy. */
export async function startPreview(specFile: string, port: number) {
  const child = spawn(
    process.execPath,
    [cli, 'preview', specFile, '--port', String(port), '--no-open'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let log = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (c) => (log += String(c)))
  const url = `http://localhost:${port}/`
  await waitForHttp(url, child, () => log)
  return {
    url,
    close: async () => {
      child.kill('SIGTERM')
      await new Promise((r) => child.once('exit', r))
    },
  }
}

/** The assembled site, with its real headers, on `port`; `specs` are served at `/__specs/<name>.json`. */
export async function startSite(port: number, specs: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'sb-oauth-site-'))
  assembleSite(dir)
  const server = createServer(await siteHandler(dir, specs))
  await new Promise<void>((r) => server.listen(port, r))
  return {
    /** the viewer's address for one of the specs */
    viewerUrl: (name: string) => {
      const spec = encodeURIComponent(`http://localhost:${port}/__specs/${name}.json`)
      return `http://localhost:${port}/v1/?spec=${spec}`
    },
    close: async () => {
      await new Promise((r) => server.close(r))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Opens a page, goes to one operation and picks the live environment, where the credentials prompt is. */
export async function openOperation(ctx: BrowserContext, url: string, key: string) {
  const page = await ctx.newPage()
  const errors: string[] = []
  const visited: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('framenavigated', (f) => visited.push(f.url()))
  await page.goto(url)
  await page.waitForSelector('.header .brand', { timeout: 60_000 })
  await page.evaluate((k) => {
    location.hash = `#/op/${encodeURIComponent(k)}`
  }, key)
  await page.waitForSelector('.request-panel .rq-bar', { timeout: 30_000 })
  await page
    .locator('.header-controls label.row', { hasText: 'Environment' })
    .locator('select')
    .selectOption('live')
  return { page, errors, visited }
}

/** What is held in this tab for an API origin, read the way a person's devtools would show it. */
export async function storedFor(page: Page, origin: string, name: string) {
  return page.evaluate(
    ([o, n]) => {
      const table = JSON.parse(sessionStorage.getItem('specbook.secrets.v1') ?? '{}')
      return {
        token: table[o as string]?.[n as string] as string | undefined,
        local: JSON.stringify({ ...localStorage }),
      }
    },
    [origin, name] as const,
  )
}
