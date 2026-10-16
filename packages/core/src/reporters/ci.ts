// Where a run happens, from the environment a CI system sets, for the report's header and its links.

export interface CiInfo {
  provider: string
  runUrl?: string
  sha?: string
  branch?: string
}

export function detectCi(env: Record<string, string | undefined>): CiInfo | undefined {
  if (env.GITHUB_ACTIONS === 'true') {
    const server = env.GITHUB_SERVER_URL ?? 'https://github.com'
    return {
      provider: 'github-actions',
      runUrl:
        env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
          ? `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
          : undefined,
      sha: env.GITHUB_SHA,
      branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME,
    }
  }
  if (env.GITLAB_CI === 'true')
    return {
      provider: 'gitlab-ci',
      runUrl: env.CI_PIPELINE_URL,
      sha: env.CI_COMMIT_SHA,
      branch: env.CI_COMMIT_REF_NAME,
    }
  if (env.CIRCLECI === 'true')
    return {
      provider: 'circleci',
      runUrl: env.CIRCLE_BUILD_URL,
      sha: env.CIRCLE_SHA1,
      branch: env.CIRCLE_BRANCH,
    }
  if (env.BUILDKITE === 'true')
    return {
      provider: 'buildkite',
      runUrl: env.BUILDKITE_BUILD_URL,
      sha: env.BUILDKITE_COMMIT,
      branch: env.BUILDKITE_BRANCH,
    }
  if (env.JENKINS_URL)
    return {
      provider: 'jenkins',
      runUrl: env.BUILD_URL,
      sha: env.GIT_COMMIT,
      branch: env.GIT_BRANCH,
    }
  if (env.CI) return { provider: 'ci' }
  return undefined
}
