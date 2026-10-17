import { signal } from '@preact/signals'

/** Bumped whenever sources may have changed; used to bust dynamic-import caches. */
export const version = signal(Date.now())
export const env = signal('mock')
export const environments = signal<string[]>(['mock'])
/** Environments the config marks `production` or `sandbox`; others are judged by their name. */
export const environmentRisk = signal<Record<string, 'production' | 'sandbox'>>({})
/** What the config says each environment is, for the tooltip of its entry in a picker. */
export const environmentNote = signal<Record<string, string>>({})
export const locale = signal<string | undefined>(undefined)
export const seed = signal<number | undefined>(undefined)
/** Bumped when an environment's variables change, so what is derived from them (addresses, origins) is redone. */
export const envVarsVersion = signal(0)
/** Whether Environment settings is open; set from elsewhere to point a person at it. */
export const envSettingsOpen = signal(false)
/** The New environment dialog. */
export const newEnvironmentOpen = signal(false)
/** What the shell around the panels offers. An embed has no dialog for creating an environment or for settings. */
export const features = signal({ createEnvironment: true, environmentSettings: true })
