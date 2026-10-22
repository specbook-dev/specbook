import { sequence } from '@specbook/core'
import getAccounts from '../requests/plaid/accounts-get.req'
import exchangeToken from '../requests/plaid/item-public-token-exchange.req'
import createPublicToken from '../requests/plaid/sandbox-public-token-create.req'
import getTransactions from '../requests/plaid/transactions-get.req'

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

export default sequence({
  id: 'link-bank-account',
  title: 'Link a bank account in the Plaid sandbox',
  description:
    'Create a sandbox public token, exchange it for an access token, then read back the accounts and transactions.',
  tags: ['plaid', 'smoke'],
})
  .step('Create a sandbox public token', createPublicToken) // captures `publicToken`
  .step('Exchange the public token', (ctx) =>
    exchangeToken.with({ data: { public_token: ctx.captured.publicToken ?? '' } }),
  ) // captures `accessToken`, `itemId`
  .step('Get the accounts', (ctx) =>
    getAccounts.with({ data: { access_token: ctx.captured.accessToken ?? '' } }),
  ) // captures `accountIds`
  .step('Get the transactions', (ctx) =>
    getTransactions.with({
      data: {
        access_token: ctx.captured.accessToken ?? '',
        start_date: isoDay(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
        end_date: isoDay(new Date()),
      },
    }),
  ) // captures `transactionAccountIds`, `totalTransactions`
  .check('Transactions belong to the linked accounts', (ctx, { assert }) => {
    for (const id of ctx.captured.transactionAccountIds) {
      assert.ok(
        ctx.captured.accountIds.includes(id),
        `transaction account ${id} is one of the linked accounts`,
      )
    }
  })
