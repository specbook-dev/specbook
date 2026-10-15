// Downloads the large public OpenAPI specs used by the example at pinned commits.
// They are gitignored (GitHub's alone is ~10MB). Run: pnpm fetch-specs
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SPECS = [
  {
    out: 'openapi/stripe.json',
    url: 'https://raw.githubusercontent.com/stripe/openapi/e73367dba9e88388c9244de65874fd3a07cb1b4d/openapi/spec3.json',
  },
  {
    out: 'openapi/github.json',
    url: 'https://raw.githubusercontent.com/github/rest-api-description/ed53824e1c478442f3aec593ccdb4d86d085cacb/descriptions/api.github.com/api.github.com.json',
  },
]

for (const s of SPECS) {
  process.stdout.write(`${s.out} … `)
  const res = await fetch(s.url)
  if (!res.ok) throw new Error(`${s.url}: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  JSON.parse(buf.toString('utf8')) // refuse to save a truncated or non-JSON download
  await mkdir(dirname(join(root, s.out)), { recursive: true })
  await writeFile(join(root, s.out), buf)
  console.log(
    `${(buf.length / 1e6).toFixed(1)} MB sha256:${createHash('sha256').update(buf).digest('hex').slice(0, 12)}`,
  )
}
