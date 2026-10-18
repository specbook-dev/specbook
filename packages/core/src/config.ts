import type { FakerConfig } from './faker-runtime'
import type { AuthProfile } from './runner/run'
import type { SecretProvider, SecretRef } from './secrets'

/** What the UI shows for an environment beyond its variables. */
export interface EnvironmentConfig {
  vars?: Record<string, unknown>
  /**
   * How careful the UI should look. `production` shows the environment in red wherever it is named;
   * `sandbox` keeps it amber even when the name contains "prod". Unset: red if the name contains
   * "prod", amber otherwise (`mock` is always neutral).
   */
  risk?: 'production' | 'sandbox'
  /** One line on what this environment is; shown as the tooltip of its entry in the pickers. */
  description?: string
}

export interface ServiceConfig<E extends string = string> {
  /** Path to an OpenAPI/Swagger file (relative to the config's project root). */
  spec: string
  /**
   * Where calls go. A template over the environment's variables (`'{{petstoreUrl}}'`: config `vars`, then
   * `environments.<env>.vars`, then `.specbook/environments/<env>.env`), which also makes `live` an
   * environment; or one address per environment.
   */
  baseUrl: string | Partial<Record<E | 'live', string>>
  /** Default auth profile for this service. */
  auth?: string
}

/** How the docs site presents itself. Everything is optional; unset fields fall back to the API's own title. */
export interface BrandingConfig {
  /** Header, overview and browser-tab title. */
  name?: string
  /** The overview's headline, under the logo: what this site is for. The name stays in the header and tab. */
  title?: string
  tagline?: string
  /** Accent colour for buttons, selection and links (any hex colour). */
  accent?: string
  /** Accent in dark mode, when the light one needs to differ. */
  accentDark?: string
  /**
   * Logo and favicon as URLs. Without these, drop `logo.svg` / `favicon.svg` (or png, jpg, webp)
   * into `.specbook/branding/` and they are picked up.
   */
  logo?: string
  favicon?: string
  /** Links shown under the overview text. */
  links?: { label: string; href: string }[]
  /**
   * Show "Powered by Specbook" under the overview of a published site (default). Set `false` to hide it.
   * It is never shown by the dev server, or on a `*.specbook.dev` page.
   */
  badge?: boolean
}

export interface SpecbookConfig<E extends string = string> {
  project: string
  /**
   * Non-sensitive variables, safe to commit: the defaults every environment starts from. An environment
   * overrides them in `environments.<env>.vars` or `.specbook/environments/<env>.env`.
   */
  vars?: Record<string, unknown>
  environments?: Partial<Record<E, EnvironmentConfig>>
  /** Secret references; OSS resolves them from env vars / dotenv files. */
  secrets?: Record<string, SecretRef>
  services: Record<string, ServiceConfig<E>>
  auth?: Record<string, AuthProfile>
  secretProviders?: SecretProvider[]
  faker?: FakerConfig
  /**
   * How long a request waits for an answer, in milliseconds, in a run from the command line or a browser. A request's own
   * `timeoutMs` wins, and `specbook test --timeout` wins over this. 0 waits for as long as it takes. Default: 30 seconds.
   */
  timeoutMs?: number
  codegen?: { outDir?: string; importPrefix?: string }
  branding?: BrandingConfig
}

export function defineConfig<const E extends string = string>(
  c: SpecbookConfig<E>,
): SpecbookConfig<E> {
  return c
}
