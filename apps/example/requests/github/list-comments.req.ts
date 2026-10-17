import { withMock } from '@specbook/core'
import { IssuesListComments } from '#api/github'

export default withMock(
  IssuesListComments.request({
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
  }),
  (req, res) => {
    if (res.status === 200) res.data = [{ ...res.data[0], body: String(req.vars.comment) }]
  },
)
