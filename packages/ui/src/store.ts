import { signal } from '@preact/signals'

/** Bumped whenever sources may have changed; used to bust dynamic-import caches. */
export const version = signal(Date.now())
export const env = signal('mock')
export const environments = signal<string[]>(['mock'])
/** Environments the config marks `production` or `sandbox`; others are judged by their name. */
export const environmentRisk = signal<Record<string, 'production' | 'sandbox'>>({})
export const locale = signal<string | undefined>(undefined)
export const seed = signal<number | undefined>(undefined)
