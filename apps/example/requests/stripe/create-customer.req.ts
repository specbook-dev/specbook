import { withMock } from '@specbook/core'
import { faker } from '@specbook/core/faker'
import { PostCustomers } from '#api/stripe'

export default withMock(
  PostCustomers.request({
    name: 'Create a customer',
    init: { email: () => faker.internet.email(), fullName: () => faker.person.fullName() },
    data: { email: '{{email}}', name: '{{fullName}}', metadata: { source: 'specbook' } },
    capture: { customerId: (res) => (res.status === 200 ? res.data.id : '') },
    assert: (res, { assert, vars }) => {
      assert.is(res.status, 200, 'customer created')
      if (res.status === 200) {
        assert.match(res.data.id, /^cus_/, 'has a customer id')
        assert.is(res.data.email, vars.email, 'echoes the email')
      }
    },
  }),
  (_req, res) => {
    if (res.status === 200) res.data.id = 'cus_mock_123'
  },
)
