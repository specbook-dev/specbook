import { IssuesCreateComment } from '#api/github'

export default IssuesCreateComment.request({
  name: 'Comment on an issue',
  init: { issueNumber: 42, comment: 'Looking into this.' },
  path: { owner: '{{owner}}', repo: '{{repo}}', issue_number: '{{issueNumber}}' },
  data: { body: '{{comment}}' },
  assert: (res, { assert, vars }) => {
    assert.is(res.status, 201, 'comment created')
    if (res.status === 201) assert.is(res.data.body, vars.comment, 'echoes the comment')
  },
  mock: { responses: { 201: { body: '{{comment}}' } } },
})
