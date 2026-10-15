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
  mock: {
    responses: {
      200: [
        {
          id: 208045946,
          node_id: 'MDU6TGFiZWwyMDgwNDU5NDY=',
          url: 'https://api.github.com/repos/{{owner}}/{{repo}}/labels/{{label}}',
          name: '{{label}}',
          description: 'Something is not working',
          color: 'f29513',
          default: true,
          archived_at: null,
          archived_by: null,
        },
      ],
    },
  },
})
