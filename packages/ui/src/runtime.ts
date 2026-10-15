import * as reg from 'virtual:specbook/registry'
import { createEngine, pickRunnable } from './engine'
import { detectExtension, type ExtensionBridge } from './extension'
import { version } from './store'

export const registry = reg

// looking for the extension costs a short wait when it is absent, so a run does not repeat it
let found: { at: number; bridge: ExtensionBridge | undefined } | undefined
const extension = async () => {
  if (found && Date.now() - found.at < 30_000) return found.bridge
  const bridge = await detectExtension()
  found = { at: Date.now(), bridge }
  return bridge
}

export const engine = createEngine(reg as never, { extension })

export const isStatic = reg.mode === 'static'

/** Dev only: writes a project file through the plugin, then busts import caches. */
export async function saveFile(path: string, content: string): Promise<void> {
  const r = await fetch('/__specbook/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content }),
  })
  if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? 'save failed')
  version.value = Date.now()
}

export { pickRunnable }
