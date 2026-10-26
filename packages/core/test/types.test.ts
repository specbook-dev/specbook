import { describe, expect, expectTypeOf, it } from 'vitest'
import type { InferControls, PageElement } from '../src'
import { c, defineOperation, script, sequence, withMock } from '../src'

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

describe('script types', () => {
  // the inputs are declared once; what the body returns is the output
  const inputs = {
    clientToken: c.text(),
    amount: c.number({ default: 10 }),
    currency: c.select(['USD', 'EUR'] as const),
  }
  const output = { nonce: 'n', payerId: 'p' }
  type Inputs = InferControls<typeof inputs>
  const approve = script({
    id: 'approve',
    name: 'Approve',
    inputs,
    run: async (i: Inputs) => ({ nonce: i.clientToken, payerId: String(i.amount) }),
  })

  it('captures every key of the output, typed from the output', () => {
    sequence({ id: 's', title: 'S' })
      .step('Approve', approve.with({ inputs: { clientToken: 'tok' } }))
      .check('types', (ctx) => {
        expectTypeOf(ctx.captured.nonce).toEqualTypeOf<string>()
        expectTypeOf(ctx.captured.payerId).toEqualTypeOf<string>()
      })
  })

  it('takes a script built from the flow so far, and checks its inputs', () => {
    sequence({ id: 's', title: 'S' })
      .step('Get token', CreateOrder.request({ capture: { clientToken: () => 'x' } }))
      .step('Approve', (ctx) => approve.with({ inputs: { clientToken: ctx.captured.clientToken } }))
      .check('types', (ctx) => {
        expectTypeOf(ctx.captured.nonce).toEqualTypeOf<string>()
        expectTypeOf(ctx.captured.clientToken).toEqualTypeOf<string>()
      })
    approve.with({ inputs: { amount: '{{amount}}', currency: 'EUR' } })
    // @ts-expect-error amount is a number (or a placeholder string)
    approve.with({ inputs: { amount: true } })
    // @ts-expect-error not one of the options
    approve.with({ inputs: { currency: 'GBP' } })
    // @ts-expect-error not an input of this script
    approve.with({ inputs: { nope: 1 } })
  })

  it('a capture map decides what is captured, and types it', () => {
    const only = script({
      id: 'only',
      name: 'Only',
      runtime: 'isomorphic',
      inputs,
      capture: { token: (out) => out.nonce },
      run: async () => output,
    })
    sequence({ id: 's', title: 'S' })
      .step('Only', only.with({ inputs: { clientToken: 't' } }))
      .check('types', (ctx) => {
        expectTypeOf(ctx.captured.token).toEqualTypeOf<string>()
        // @ts-expect-error payerId is not captured when a capture map is given
        ctx.captured.payerId
      })
  })

  it('checks the body against the contract: its inputs and its output', () => {
    script({
      id: 'a',
      name: 'A',
      inputs,
      // a body may ask for less than it is given
      run: async (i: { clientToken: string }) => ({ nonce: i.clientToken, payerId: 'x' }),
    })
    script({
      id: 'b',
      name: 'B',
      inputs,
      // @ts-expect-error the contract has no `missing` input
      run: async (i: { missing: boolean }) => ({ nonce: 'x', payerId: String(i.missing) }),
    })
    script({
      id: 'c',
      name: 'C',
      inputs,
      // @ts-expect-error amount is a number in the contract
      run: async (i: { amount: string }) => ({ nonce: i.amount, payerId: 'x' }),
    })
    // the output is what the body returns, so a capture or an assert that asks for another field is the error
    script({
      id: 'd',
      name: 'D',
      inputs,
      run: async () => ({ nonce: 'x', payerId: 'x' }),
      // @ts-expect-error not a field of what the body returns
      assert: (out) => out.missing,
    })
  })

  it('types an inline body from the controls, and a loaded one from its default export', () => {
    script({
      id: 'e',
      name: 'E',
      inputs,
      run: async (i) => {
        expectTypeOf(i.amount).toEqualTypeOf<number>()
        expectTypeOf(i.currency).toEqualTypeOf<'USD' | 'EUR'>()
        return output
      },
    })
    script({
      id: 'f',
      name: 'F',
      inputs,
      load: async () => ({
        run: async (i: Inputs) => ({ nonce: i.clientToken, payerId: 'x' }),
      }),
    })
    script({
      id: 'g',
      name: 'G',
      inputs,
      // @ts-expect-error the loaded body asks for an input the contract lacks
      load: async () => ({
        run: async (i: { missing: boolean }) => ({ nonce: 'x', payerId: `${i.missing}` }),
      }),
    })
    script({
      id: 'g2',
      name: 'G2',
      inputs,
      // @ts-expect-error a file that only has a default export is not a body: the export is called `run`
      load: async () => ({ default: async () => output }),
    })
  })

  it('names a page element only as the DOM types allow', () => {
    // the base tsconfig has the DOM library, so a body gets a real element to render into
    expectTypeOf<PageElement>().toEqualTypeOf<HTMLElement>()
  })

  it('a script has either a body or a loader, never both', () => {
    // the types refuse it, and so does construction for a file that is not type-checked
    expect(() => {
      // @ts-expect-error neither run nor load
      script({ id: 'h', name: 'H' })
    }).toThrow(/needs a body/)
    expect(() => {
      // @ts-expect-error both
      script({
        id: 'i',
        name: 'I',
        run: async () => output,
        load: async () => ({ run: async () => output }),
      })
    }).toThrow(/not both/)
  })

  it('withMock types the hook from the controls, and its answer from what the body returns', () => {
    withMock(approve, (req, res) => {
      expectTypeOf(req.inputs.amount).toEqualTypeOf<number>()
      res.delayMs = 5
      return { nonce: 'n', payerId: `PAYER-${req.inputs.amount}` }
    })
    // @ts-expect-error the answer lacks a field the body returns
    withMock(approve, () => ({ nonce: 'n' }))
    // @ts-expect-error the answer has another type than the body returns
    withMock(approve, () => ({ nonce: 1, payerId: 'p' }))
  })

  it('a body annotated with a union types the capture as that union', () => {
    type Verdict = { status: 'approved' | 'declined' }
    const decide = script({
      id: 'decide',
      name: 'Decide',
      run: async (): Promise<Verdict> => ({ status: 'approved' }),
    })
    sequence({ id: 's', title: 'S' })
      .step('Decide', decide)
      .check('types', (ctx) => {
        expectTypeOf(ctx.captured.status).toEqualTypeOf<'approved' | 'declined'>()
      })
  })
})
