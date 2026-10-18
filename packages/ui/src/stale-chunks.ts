/**
 * A tab left open across a deploy asks for chunks the new build no longer has. Vite reports that as `vite:preloadError`;
 * this loads the new page instead, once a minute at most so a real outage cannot become a reload loop.
 */
export interface StaleChunkEnv {
  now: () => number
  /** the time of the last reload made for this, kept for the tab */
  last: () => number
  remember: (t: number) => void
  reload: () => void
}

export function reloadForStaleChunk(env: StaleChunkEnv): boolean {
  const t = env.now()
  if (t - env.last() < 60_000) return false
  env.remember(t)
  env.reload()
  return true
}

const KEY = 'specbook:stale-chunk-reload'

/** Reload on a chunk that is gone. A tab with no session storage is left alone: it could not stop a loop. */
export function watchStaleChunks(): void {
  window.addEventListener('vite:preloadError', (event) => {
    try {
      const reloaded = reloadForStaleChunk({
        now: Date.now,
        last: () => Number(sessionStorage.getItem(KEY) ?? 0),
        remember: (t) => sessionStorage.setItem(KEY, String(t)),
        reload: () => location.reload(),
      })
      if (reloaded) event.preventDefault()
    } catch {
      /* no session storage */
    }
  })
}
