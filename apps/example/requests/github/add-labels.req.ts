import { IssuesAddLabels } from '#api/github'

export default IssuesAddLabels.request({
  name: 'Label an issue',
  init: { issueNumber: 42, label: 'bug' },
  path: { owner: '{{owner}}', repo: '{{repo}}', issue_number: '{{issueNumber}}' },
  data: { labels: ['{{label}}'] },
  assert: (res, { assert }) => {
    assert.is(res.status, 200, 'labels added')
  },
  // a whole label, so the mocked response also satisfies the spec's schema
})
