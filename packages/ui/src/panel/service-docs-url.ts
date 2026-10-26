import { useEffect, useState } from 'preact/hooks'
import { engine } from '../runtime'
import { version } from '../store'

/** The `docsUrl` a project's config gives a service; nothing when the project names none, or there is no project. */
export function useServiceDocsUrl(service: string | undefined): string | undefined {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    let live = true
    setUrl(undefined)
    if (service)
      engine
        .config(version.value)
        .then((cfg) => {
          const docs = cfg.services?.[service]?.docsUrl
          if (live) setUrl(typeof docs === 'string' ? docs : undefined)
        })
        .catch(() => {})
    return () => {
      live = false
    }
  }, [service, version.value])
  return url
}
