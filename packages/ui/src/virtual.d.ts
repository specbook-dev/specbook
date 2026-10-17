declare module 'virtual:specbook/registry' {
  interface Entry {
    file: string
    load: (version: number) => Promise<Record<string, any>>
    /** static builds only */
    source?: () => Promise<string>
  }
  export const mode: 'dev' | 'static'
  /** A build that publishes only the operations the project's requests and flows use. */
  export const minimal: boolean | undefined
  export const project: { root: string; outDir: string; requestsDir: string }
  export const manifests: Record<
    string,
    {
      service: string
      title?: string
      version?: string
      /** from the spec's `info.x-logo` */
      logo?: { url: string; altText?: string; backgroundColor?: string }
      tags: string[]
      operations: {
        id: string
        method: string
        path: string
        summary?: string
        tags: string[]
        statuses: number[]
        /** the spec requires credentials */
        secured?: boolean
      }[]
    }
  >
  /** Fetches the manifests of the named services (all when none are named) into `manifests`. A build starts with it empty. */
  export const loadManifests: (services?: string[]) => Promise<void>
  export const requests: Entry[]
  /** Which `service/Operation` each request file is for, read from its text (no import), by project-relative file. */
  export const requestMeta: Record<string, string>
  /** Request files whose text does not say; these are imported to be listed. */
  export const unresolvedRequests: string[]
  export const sequences: Entry[]
  /** Sequence headers read from the `*.seq.ts` text (no import), keyed by id. */
  export const sequenceMeta: Record<
    string,
    {
      id: string
      title: string
      description?: string
      tags?: string[]
      group?: string
      file: string
    }
  >
  /** Sequence files whose header is not plain literals; these are imported to be listed. */
  export const unresolvedSequences: string[]
  /** `.specbook/branding/logo.*` and `favicon.*`, resolved to URLs on demand. */
  export const brandingAssets: Partial<Record<'logo' | 'favicon', () => Promise<string>>>
  /** Non-secret variables from `.specbook/environments/<env>.env`, by environment. */
  export const environmentVars: Record<string, Record<string, string>>
  /** Long description and example titles per `service/OperationId`, loaded when its page opens. */
  export const operationDocs: Record<
    string,
    () => Promise<{
      default: { description?: string; examples: { name: string; title: string; source: string }[] }
    }>
  >
  export const operations: Record<string, (version: number) => Promise<Record<string, any>>>
  /** JSON Schema of the request object ({ path, query, headers, data }) per `service/OperationId` */
  export const schemas: Record<string, () => Promise<{ default: Record<string, any> }>>
  /** JSON Schema per response status, per `service/OperationId`: { "200": schema, ... } */
  export const responseSchemas: Record<string, () => Promise<{ default: Record<string, any> }>>
  /** Shared component definitions per service */
  export const definitions: Record<string, () => Promise<{ default: Record<string, any> }>>
  export const examples: Record<string, (version: number) => Promise<{ default: unknown }>>
  /** Request examples per `service/OperationId`; project files override generated ones of the same name. */
  export const requestExamples: Record<
    string,
    {
      name: string
      source: 'generated' | 'project'
      dir: string
      load: (version: number) => Promise<{ default: unknown }>
    }[]
  >
  /** Non-JSON files an example uploads, keyed `<dir>/<file>`; resolves to a URL. */
  export const assets: Record<string, () => Promise<string>>
  /** Markdown pages (compiled at build time) tied to an operation or sequence. */
  export const docs: {
    file: string
    operation?: string
    sequence?: string
    /** the `.seq.ts` this page sits beside */
    sequenceFile?: string
    /** the `.req.ts` this page sits beside */
    requestFile?: string
    /** the page replaces the operation's spec description */
    replace?: boolean
    title?: string
    load: () => Promise<string>
  }[]
  export const loadFaker: ((version: number) => Promise<Record<string, any>>) | null
  export const loadConfig: (version: number) => Promise<{ default: any }>
}

declare module 'virtual:specbook/manifests' {
  // a side effect only: it puts the manifest of every service into the registry's `manifests`
}

declare module 'virtual:specbook/types' {
  const types: { libs: Record<string, string>; sources: Record<string, string> }
  export default types
}

declare module 'virtual:specbook/faker' {
  const mod: Record<string, any>
  export = mod
}
