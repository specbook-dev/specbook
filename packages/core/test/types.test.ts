import { describe, expectTypeOf, it } from 'vitest'
import type { InferControls } from '../src'
import { c, defineOperation, sequence } from '../src'

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
})
