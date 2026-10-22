import { c, sequence } from '@specbook/core'
import accountsGet from '../requests/plaid/accounts-get.req'
import itemPublicTokenExchange from '../requests/plaid/item-public-token-exchange.req'
import sandboxPublicTokenCreate from '../requests/plaid/sandbox-public-token-create.req'
import transactionsGet from '../requests/plaid/transactions-get.req'

/** The date `daysAgo` days before today, as YYYY-MM-DD (UTC). */
const isoDay = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)

export default sequence({
  id: 'link-bank-account',
  title: 'Link a bank account in the Plaid sandbox',
  description:
    "Creates a sandbox item, exchanges its public token for an access token, then reads back the item's accounts and transactions.",
  tags: ['plaid', 'sandbox'],
  inputs: {
    days: c.number({
      default: 90,
      min: 1,
      max: 730,
      description: 'How many days of transactions to read.',
    }),
  },
})
  .step('Create a sandbox public token', sandboxPublicTokenCreate) // captures `publicToken`
  .step('Exchange it for an access token', (ctx) =>
    itemPublicTokenExchange.with({ data: { public_token: ctx.captured.publicToken } }),
  ) // captures `accessToken`, `itemId`
  .step('Read the accounts', (ctx) =>
    accountsGet.with({ data: { access_token: ctx.captured.accessToken } }),
  ) // captures `accountIds`, `accountsItemId`
  .check('The accounts belong to the linked item', (ctx, { assert }) => {
    assert.is(
      ctx.captured.accountsItemId,
      ctx.captured.itemId,
      'accounts are from the item just linked',
    )
  })
  .step('Read the transactions', (ctx) =>
    transactionsGet.with({
      data: {
        access_token: ctx.captured.accessToken,
        start_date: isoDay(ctx.inputs.days),
        end_date: isoDay(0),
      },
    }),
  ) // captures `transactionAccountIds`
  .check('The transactions are on the linked accounts', (ctx, { assert }) => {
    const unknown = ctx.captured.transactionAccountIds.filter(
      (id) => !ctx.captured.accountIds.includes(id),
    )
    assert.equal(unknown, [], 'every transaction is on an account read above')
  })
