import { GitHubMark } from '../panel/icons'
import { REPO_URL } from '../viewer/site'

/**
 * A way to the repository. Only in the viewer (a project's own published site has its own header and is
 * not ours to put links in).
 */
export function GitHubStar() {
  if (!globalThis.__SPECBOOK_VIEWER__?.source) return null
  return (
    <a
      class="btn gh-star"
      href={REPO_URL}
      target="_blank"
      rel="noopener"
      title="Specbook's source is on GitHub"
    >
      <GitHubMark />
      <span class="gh-label">GitHub</span>
    </a>
  )
}
