import { IssuesUpdate } from '#api/github'

export default IssuesUpdate.request({
  name: 'Close an issue',
  init: { issueNumber: 42 },
  path: { owner: '{{owner}}', repo: '{{repo}}', issue_number: '{{issueNumber}}' },
  data: { state: 'closed' },
  assert: (res, { assert }) => {
    assert.is(res.status, 200, 'updated')
    if (res.status === 200) assert.is(res.data.state, 'closed', 'is closed')
  },
  mock: { responses: { 200: { state: 'closed' } } },
})
