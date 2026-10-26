import type { OAuthSettings } from '@specbook/core/internal'

export interface AuthProfileLike {
  title: string
  /** the spec scheme(s) this profile satisfies */
  scheme?: string | string[]
  apply: { headers?: Record<string, string>; query?: Record<string, string> }
  /** a sign-in the page can offer (authorization code, implicit or OpenID Connect), or a client credentials grant */
  oauth?: OAuthSettings
}
