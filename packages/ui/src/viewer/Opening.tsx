import markUrl from '../assets/mark.svg'

const ROWS = [78, 92, 64, 84, 70, 88, 60, 80, 72, 90, 66, 76]
// the header's controls on a wide screen, by width: two labelled selects, then three icon buttons
const PILLS = [93, 118, 81, 72, 46, 46, 32]

/**
 * What a link to `?spec=` shows while the document downloads: the app's own header and two columns, so
 * the real UI replaces it in place instead of a centred card giving way to a different layout. It reuses
 * the shell's structural classes for the geometry and none of the ones tests and scripts look for.
 */
export function Opening({ what, progress }: { what: string; progress?: string }) {
  return (
    <div class="app sk" role="status" aria-live="polite" aria-busy="true">
      <header class="header">
        <span class="sk-brand">
          <img src={markUrl} alt="" width="24" height="24" />
          Specbook
        </span>
        <span class="sk-search" aria-hidden="true" />
        <span class="spacer" />
        {PILLS.map((w) => (
          <span class="sk-pill" style={{ width: `${w}px` }} aria-hidden="true" />
        ))}
        <span class="sk-menu" aria-hidden="true" />
      </header>
      <div class="layout" data-view="splash">
        <nav class="list-col" aria-hidden="true">
          <span class="sk-filter" />
          {ROWS.map((w) => (
            <span class="sk-row" style={{ width: `${w}%` }} />
          ))}
        </nav>
        <main class="stage">
          <p class="sk-status">{progress ?? 'Opening…'}</p>
          <p class="sk-what" title={what}>
            {what}
          </p>
        </main>
      </div>
    </div>
  )
}
