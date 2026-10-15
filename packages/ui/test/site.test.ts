import { describe, expect, it } from 'vitest'
import { REPO_URL } from '../src/viewer/site'

describe('the repository link', () => {
  it('names the organisation’s repository', () => {
    expect(REPO_URL).toBe('https://github.com/specbook-dev/specbook')
  })
})
