import { c, sequence } from '@specbook/core'
import addLabels from '../requests/github/add-labels.req'
import closeIssue from '../requests/github/close-issue.req'
import createComment from '../requests/github/create-comment.req'
import createIssue from '../requests/github/create-issue.req'
import listComments from '../requests/github/list-comments.req'

export default sequence({
  id: 'github-triage',
  title: 'Triage a GitHub issue',
  description:
    'Create an issue, label it, comment, verify the comment, then close it. Use a sandbox repo.',
  tags: ['github'],
  params: {
    label: c.select(['bug', 'enhancement', 'question'] as const, { default: 'bug' }),
    comment: c.text({ default: 'Looking into this.' }),
  },
})
  .step('Create issue', createIssue)
  .step('Add label', addLabels)
  .step('Comment', createComment)
  .step('Verify comment', listComments)
  .step('Close issue', closeIssue)
