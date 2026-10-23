import { signal } from '@preact/signals'
import { kv } from './storage'

/**
 * Which of a service's auth profiles the person picked, per service, for this tab. A choice only reorders the service's
 * list: an operation that does not accept the chosen profile still uses the first one it does.
 */
const KEY = 'specbook.auth.v1'

let loaded = false
export const authChoices = signal<Record<string, string>>({})

function load() {
  if (loaded) return
  loaded = true
  try {
    const stored = JSON.parse(kv.session.getItem(KEY) ?? '{}')
    if (stored && typeof stored === 'object') authChoices.value = stored
  } catch {
    /* unreadable or blocked: no choice yet */
  }
}

export function getChoice(service: string): string | undefined {
  load()
  return authChoices.value[service]
}

export function setChoice(service: string, name: string | undefined): void {
  load()
  const next = { ...authChoices.value }
  if (name) next[service] = name
  else delete next[service]
  authChoices.value = next
  try {
    kv.session.setItem(KEY, JSON.stringify(next))
  } catch {
    /* the choice holds for this page load */
  }
}
