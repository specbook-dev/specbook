import type { OAuthSettings } from '@specbook/core'

export interface AuthProfileLike {
  title: string
  apply: { headers?: Record<string, string>; query?: Record<string, string> }
  /** the scheme's authorization code flow, when it has one the page can sign in to */
  oauth?: OAuthSettings
}
