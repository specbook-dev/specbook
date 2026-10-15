import { IssuesListComments } from '#api/github'

export default IssuesListComments.request({
  name: 'List issue comments',
  init: { issueNumber: 42, comment: 'Looking into this.' },
  path: { owner: '{{owner}}', repo: '{{repo}}', issue_number: '{{issueNumber}}' },
  assert: (res, { assert, vars }) => {
    assert.is(res.status, 200, 'ok')
    if (res.status === 200) {
      assert.ok(
        res.data.some((x) => x.body === vars.comment),
        'contains our comment',
      )
    }
  },
  mock: { responses: { 200: [{ body: '{{comment}}' }] } },
})
