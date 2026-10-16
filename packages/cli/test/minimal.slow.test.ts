import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { generateCommand } from '../src/commands/generate'
import { buildCommand } from '../src/commands/ui'
import { createLoader } from '../src/load'
import { loadProject } from '../src/project'

const root = resolve(__dirname, '../../../apps/example')

async function all(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await all(p)))
    else out.push(p)
  }
  return out
}

describe('a minimal build', () => {
  it('publishes the operations the project uses and none of the rest of the API', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const out = await mkdtemp(join(tmpdir(), 'sb-minimal-'))
    afterAll(() => rm(out, { recursive: true, force: true }))
    const loader = await createLoader(root)
    afterAll(() => loader.close())
    const project = await loadProject(root, loader)
    await generateCommand(project, loader)
    await buildCommand(project, out, { minimal: true })

    const files = await all(out)
    // the example's full build is about 2,100 files and 39 MB
    expect(files.length).toBeLessThan(400)
    let bytes = 0
    for (const f of files) bytes += (await stat(f)).size
    expect(bytes).toBeLessThan(8 * 1024 * 1024)

    const text = (await Promise.all(files.map((f) => readFile(f, 'utf8').catch(() => '')))).join(
      '\n',
    )
    // used operations are there...
    for (const id of ['FindPetsByStatus', 'IssuesCreate', 'PostPaymentIntents', 'Query'])
      expect(text, id).toContain(id)
    // ...and operations nothing uses, in services that are published, are in no file at all
    for (const id of [
      'PostCharges',
      'ActionsListArtifactsForRepo',
      'GetInventory',
      'ActivityListEventsForAuthenticatedUser',
    ])
      expect(text, id).not.toContain(id)

    const data = files.filter(
      (f) => /\/data\/[^/]+\/[^/]+\.json$/.test(f) && !f.endsWith('_definitions.json'),
    )
    expect(data.map((f) => f.split('/').slice(-2).join('/')).sort()).toEqual([
      'countries/Query.json',
      'github/IssuesAddLabels.json',
      'github/IssuesCreate.json',
      'github/IssuesCreateComment.json',
      'github/IssuesListComments.json',
      'github/IssuesUpdate.json',
      'petstore/AddPet.json',
      'petstore/FindPetsByStatus.json',
      'petstore/GetOrderById.json',
      'petstore/PlaceOrder.json',
      'stripe/PostCustomers.json',
      'stripe/PostPaymentIntents.json',
      'stripe/PostPaymentIntentsIntentConfirm.json',
      'stripe/PostRefunds.json',
    ])
    // GitHub's definitions shrink to what five operations refer to
    const defs = JSON.parse(await readFile(join(out, 'data/github/_definitions.json'), 'utf8')) as {
      $defs: Record<string, unknown>
    }
    expect(Object.keys(defs.$defs).length).toBeLessThan(60)

    // the metadata lists the same operations
    const meta = JSON.parse(await readFile(join(out, 'specbook.json'), 'utf8')) as {
      services: Record<string, { operations: Record<string, unknown> }>
    }
    expect(Object.keys(meta.services.github?.operations ?? {}).sort()).toEqual([
      'IssuesAddLabels',
      'IssuesCreate',
      'IssuesCreateComment',
      'IssuesListComments',
      'IssuesUpdate',
    ])
  }, 180_000)
})
