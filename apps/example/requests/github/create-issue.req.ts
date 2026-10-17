import { faker } from '@specbook/core/faker'
import { IssuesCreate } from '#api/github'

export default IssuesCreate.request({
  name: 'Create an issue',
  init: { title: () => `Bug: ${faker.hacker.phrase()}` },
  path: { owner: '{{owner}}', repo: '{{repo}}' },
  data: { title: '{{title}}', body: 'Created by specbook.' },
  capture: { issueNumber: (res) => (res.status === 201 ? res.data.number : 0) },
  assert: (res, { assert, vars }) => {
    assert.is(res.status, 201, 'issue created')
    if (res.status === 201) {
      assert.is(res.data.title, vars.title, 'echoes the title')
      assert.is(res.data.state, 'open', 'is open')
    }
  },
})
