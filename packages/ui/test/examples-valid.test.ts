import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMockVariants } from '@specbook/core'
import { describe, expect, it } from 'vitest'
import { validate } from '../src/schema'

const gen = join(__dirname, '../../../apps/example/.generated')
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

/** Generated examples must satisfy the schemas they were generated from (skipped before `specbook generate`). */
describe.skipIf(!existsSync(gen))('generated examples match their schemas', () => {
  // GitHub's spec contradicts itself in places (enum values its own examples don't use), so it gets a margin
  const allowed: Record<string, { requests: number; responses: number }> = {
    github: { requests: 0.04, responses: 0.01 },
  }

  const services = existsSync(gen)
    ? readdirSync(gen).filter((d) => existsSync(join(gen, d, 'manifest.json')))
    : []

  for (const svc of services) {
    it(svc, () => {
      const defsFile = join(gen, svc, 'schemas/definitions.schema.json')
      const defs = existsSync(defsFile) ? read(defsFile) : undefined
      const manifest = read(join(gen, svc, 'manifest.json'))
      let reqs = 0
      let reqBad = 0
      let res = 0
      let resBad = 0
      const bad: string[] = []

      for (const op of manifest.operations) {
        const reqSchema = join(gen, svc, 'schemas', `${op.id}.request.schema.json`)
        const reqExample = join(gen, svc, 'examples', op.id, 'default.example.json')
        if (existsSync(reqSchema) && existsSync(reqExample)) {
          const data = read(reqSchema).properties?.data
          const body = read(reqExample).body
          if (data && body !== undefined) {
            reqs++
            const issues = validate(body, data, defs, { reportExtra: false })
            if (issues.length) {
              reqBad++
              bad.push(`${op.id} request: ${issues[0]?.path} ${issues[0]?.message}`)
            }
          }
        }
        const resSchemas = join(gen, svc, 'schemas', `${op.id}.responses.schema.json`)
        if (!existsSync(resSchemas)) continue
        const schemas = read(resSchemas)
        for (const status of op.statuses) {
          const file = join(gen, svc, 'examples', op.id, `${status}.response.json`)
          if (!existsSync(file) || !schemas[String(status)]) continue
          // a status whose example file holds several variants: every one is an answer the mock can give
          const content = read(file)
          const bodies = isMockVariants(content)
            ? content.$variants.map((v) => ({ name: v.name, body: v.body }))
            : [{ name: undefined, body: content }]
          for (const { name, body } of bodies) {
            res++
            const issues = validate(body, schemas[String(status)], defs, { reportExtra: false })
            if (issues.length) {
              resBad++
              bad.push(
                `${op.id}.${status}${name ? `[${name}]` : ''}: ${issues[0]?.path} ${issues[0]?.message}`,
              )
            }
          }
        }
      }

      const limit = allowed[svc] ?? { requests: 0, responses: 0 }
      expect(reqBad, bad.slice(0, 5).join('\n')).toBeLessThanOrEqual(
        Math.ceil(reqs * limit.requests),
      )
      expect(resBad, bad.slice(0, 5).join('\n')).toBeLessThanOrEqual(
        Math.ceil(res * limit.responses),
      )
    })
  }
})
