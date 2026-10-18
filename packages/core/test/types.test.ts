import { describe, expectTypeOf, it } from 'vitest'
import type { InferControls } from '../src'
import { c, defineOperation, sequence, withMock } from '../src'

interface Order {
  id: string
  status: 'PENDING' | 'PAID'
}
interface ApiError {
  message: string
}
const CreateOrder = defineOperation<{
  params: {}
  body: { itemCode: string; quantity: number }
  responses: { 201: Order; 400: ApiError }
}>({ service: 'order', id: 'CreateOrder', method: 'POST', path: '/orders' })

describe('types', () => {
  it('narrows response data by status', () => {
    CreateOrder.request({
      assert: (res) => {
        if (res.status === 201) expectTypeOf(res.data).toEqualTypeOf<Order>()
        else expectTypeOf(res.data).toEqualTypeOf<ApiError>()
      },
    })
  })
  it('accumulates captures through steps and inputs through input()', () => {
    const req = CreateOrder.request({
      capture: { orderId: (res) => (res.status === 201 ? res.data.id : '') },
    })
    sequence({ id: 's', title: 'S', inputs: { from: c.select(['LAS', 'BLI'] as const) } })
      .step('create', req)
      .input('pick', () => ({ n: c.number() }))
      .check('types', (ctx) => {
        expectTypeOf(ctx.captured.orderId).toEqualTypeOf<string>()
        expectTypeOf(ctx.inputs.from).toEqualTypeOf<'LAS' | 'BLI'>()
        expectTypeOf(ctx.inputs.n).toEqualTypeOf<number>()
      })
  })
  it('each() collects captures as arrays', () => {
    const req = CreateOrder.request({ capture: { id: (r) => (r.status === 201 ? r.data.id : '') } })
    sequence({ id: 's', title: 'S' })
      .each(
        'many',
        () => [1, 2],
        () => req,
      )
      .check('c', (ctx) => {
        expectTypeOf(ctx.captured.id).toEqualTypeOf<string[]>()
      })
  })
  it('InferControls', () => {
    expectTypeOf<InferControls<{ a: ReturnType<typeof c.text> }>>().toEqualTypeOf<{ a: string }>()
  })
  it('withMock types req from the init and res from the declared statuses', () => {
    withMock(CreateOrder.request({ init: { who: 'Ada' } }), (req, res) => {
      expectTypeOf(req.vars.who).toEqualTypeOf<string>()
      if (res.status === 201) {
        expectTypeOf(res.data).toEqualTypeOf<Order>()
        res.data.status = 'PAID'
        // @ts-expect-error not a status of the order
        res.data.status = 'SHIPPED'
      } else {
        expectTypeOf(res.data).toEqualTypeOf<ApiError>()
      }
      res.respond(400, { message: 'nope' })
      // @ts-expect-error 404 is not a status this operation declares
      res.respond(404)
      // @ts-expect-error not a field of the 400 body
      res.respond(400, { oops: true })
    })
  })
})

describe('faker types', () => {
  it('types the faker request files import', async () => {
    const { faker } = await import('../src/faker')
    // never called: the proxy needs an installed instance, and only the types are checked
    const check = () => {
      expectTypeOf(faker.person.firstName()).toBeString()
      expectTypeOf(faker.number.int({ max: 5 })).toBeNumber()
      // @ts-expect-error not a faker generator
      faker.person.fistName()
      // @ts-expect-error max is a number
      faker.number.int({ max: 'x' })
    }
    expectTypeOf(check).toBeFunction()
  })
})
