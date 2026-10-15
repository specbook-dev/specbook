import { defineOperation, sequence } from '@specbook/core'
import { describe, expect, it } from 'vitest'
import { createEngine, pickRunnable } from '../src/engine'

const GetPet = defineOperation<{
  params: { path: { petId: string } }
  body: never
  responses: { 200: { id: string; name: string }; 404: { message: string } }
}>({ service: 'pets', id: 'GetPet', method: 'GET', path: '/pet/{petId}' })

const reg = {
  manifests: { pets: { operations: [{ id: 'GetPet', statuses: [200, 404] }] } },
  examples: {
    'pets/GetPet.200': async () => ({ default: { id: '{{petId}}', name: 'Rex' } }),
    'pets/GetPet.404': async () => ({ default: { message: 'nope' } }),
  },
  operations: { 'pets/GetPet': async () => ({ GetPet }) },
  requestExamples: {},
  assets: {},
  docs: [],
  loadConfig: async () => ({
    default: {
      project: 'p',
      vars: {},
      services: { pets: { spec: 'x', baseUrl: { live: 'https://x', staging: 'https://y' } } },
    },
  }),
}

describe('ui engine', () => {
  const engine = createEngine(reg)

  it('lists environments from service baseUrls, mock first', async () => {
    expect(await engine.environments(0)).toEqual(['mock', 'live', 'staging'])
  })

  it('plays a generated operation against its example, with a forced mock status', async () => {
    const def = await engine.operationRequest('pets/GetPet', 0, { path: { petId: '7' } })
    const ok = await engine.run(def, { env: 'mock', version: 0 })
    expect(ok.steps[0]?.response?.body).toEqual({ id: '7', name: 'Rex' })
    const nope = await engine.run(def, { env: 'mock', version: 0, mockStatus: 404 })
    expect(nope.steps[0]?.response?.status).toBe(404)
  })

  it('runs a sequence and pauses for input via onInput', async () => {
    const seq = sequence({ id: 's', title: 'S' })
      .step('get', GetPet.request({ path: { petId: '1' } }))
      .input('pick', () => ({ who: { kind: 'text', opts: {} } as any }))
    const asked: string[] = []
    const r = await engine.run(seq, {
      env: 'mock',
      version: 0,
      onInput: ({ name }) => {
        asked.push(name)
        return { who: 'me' }
      },
    })
    expect(asked).toEqual(['pick'])
    expect(r.status).toBe('pass')
  })

  it('loads faker only when a run can use it', async () => {
    let loads = 0
    const fakerReg = {
      ...reg,
      loadFaker: async () => {
        loads++
        return import('@faker-js/faker')
      },
    }
    const e = createEngine(fakerReg)
    await e.run(GetPet.request({ path: { petId: '1' } }), { env: 'mock', version: 0 })
    expect(loads).toBe(0)
    await e.run(GetPet.request({ path: { petId: '{{faker.person.firstName}}' } }), {
      env: 'mock',
      version: 0,
    })
    expect(loads).toBe(1)
    await e.run(GetPet.request({ init: { petId: () => 'x' }, path: { petId: '{{petId}}' } }), {
      env: 'mock',
      version: 0,
    })
    expect(loads).toBe(2)
  })

  it('pickRunnable prefers default, then any runnable export', () => {
    const req = GetPet.request({})
    expect(pickRunnable({ default: req })).toBe(req)
    expect(pickRunnable({ other: 1, named: req })).toBe(req)
    expect(pickRunnable({})).toBeUndefined()
  })
})
