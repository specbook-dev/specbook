import { c, type InferControls, script, withMock } from '@specbook/core'

// #region contract
// The contract of a script: what it is given, where it runs, and how the mock environment answers. A flow imports this file;
// the body in approve.browser.ts is fetched by the portal when the step runs, and is left out of `specbook test` and the
// bundle. What the body returns is the script's output, and the mock's answer is checked against it.
export const inputs = {
  amount: c.number({ default: 25, min: 1, description: 'What the person is asked to approve.' }),
  currency: c.select(['USD', 'EUR'] as const, { description: 'The currency of the amount.' }),
}
export type Inputs = InferControls<typeof inputs>

export default withMock(
  script({
    id: 'approve-payment',
    name: 'Approve a payment',
    description:
      'Asks the person to approve a payment by pressing a button in the step, as a payment provider’s SDK does.',
    runtime: 'browser',
    tags: ['payments'],
    inputs,
    load: () => import('./approve.browser'),
    assert: (out, { assert, inputs }) => {
      assert.is(out.amount, inputs.amount, 'the amount approved is the amount asked')
    },
  }),
  // the mock approves what it was asked, as the real one would
  ({ inputs }) => ({
    approvedAt: '2025-01-01T00:00:00.000Z',
    amount: inputs.amount,
    currency: inputs.currency,
  }),
)
// #endregion contract
