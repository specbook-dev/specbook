// Fails the build before a deploy does: Cloudflare Pages takes at most 20,000 files and 25 MiB a file on the free plan, and
// the home page and the service worker should stay small. Run as `node scripts/check-site.mjs dist`.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const MiB = 1024 * 1024

export const LIMITS = {
  /** under Cloudflare Pages' 20,000, with room */
  files: 19_000,
  /** under its 25 MiB a file, with room */
  file: 24 * MiB,
  /** the example's full build is about 39 MB, the rest a few more */
  total: 60 * MiB,
  /** gzipped, what the home page loads before anything is pressed */
  homeScripts: 60 * 1024,
  /** gzipped, the demo API */
  worker: 40 * 1024,
}

async function walk(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

const gz = async (file) => gzipSync(await readFile(file)).length

/** What a built site holds, and what is wrong with it. */
export async function checkSite(dir, limits = LIMITS) {
  const files = await walk(dir)
  const sizes = await Promise.all(
    files.map(async (f) => ({ file: relative(dir, f), size: (await stat(f)).size })),
  )
  const total = sizes.reduce((n, f) => n + f.size, 0)
  const largest = [...sizes].sort((a, b) => b.size - a.size).slice(0, 10)
  const problems = []
  if (files.length >= limits.files)
    problems.push(`${files.length} files: Cloudflare Pages takes 20,000`)
  for (const f of sizes.filter((s) => s.size >= limits.file))
    problems.push(
      `${f.file} is ${(f.size / MiB).toFixed(1)} MiB: Cloudflare Pages takes 25 MiB a file`,
    )
  if (total >= limits.total)
    problems.push(`${(total / MiB).toFixed(0)} MB in all, over the ${limits.total / MiB} MB budget`)

  try {
    const html = await readFile(join(dir, 'index.html'), 'utf8')
    let scripts = 0
    for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
      const src = m[1]
      if (/^https?:/.test(src)) continue
      const file = join(dir, src.replace(/^\//, '').split('?')[0])
      scripts += await gz(file).catch(() => 0)
    }
    if (scripts >= limits.homeScripts)
      problems.push(
        `the home page loads ${(scripts / 1024).toFixed(0)} KB of scripts (gzip), budget ${limits.homeScripts / 1024}`,
      )
  } catch {
    problems.push('there is no index.html')
  }
  try {
    const worker = await gz(join(dir, 'sw.js'))
    if (worker >= limits.worker)
      problems.push(
        `sw.js is ${(worker / 1024).toFixed(0)} KB (gzip), budget ${limits.worker / 1024}`,
      )
  } catch {
    problems.push('there is no sw.js: the demo API is missing')
  }
  return { files: files.length, total, largest, problems }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? 'dist')
  const r = await checkSite(dir)
  console.log(`${r.files} files, ${(r.total / MiB).toFixed(1)} MB`)
  for (const f of r.largest)
    console.log(`  ${(f.size / 1024).toFixed(0).padStart(7)} KB  ${f.file}`)
  for (const p of r.problems) console.error(`✗ ${p}`)
  if (r.problems.length) process.exit(1)
}
