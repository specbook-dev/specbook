// Runs before the page is drawn. The site is dark first: with no choice made it is dark, a visitor's choice (kept under
// the key Starlight uses, where an empty value means "follow the system") wins.
;(() => {
  let stored = null
  try {
    stored = localStorage.getItem('starlight-theme')
  } catch {
    /* blocked storage: the default applies */
  }
  const light = matchMedia('(prefers-color-scheme: light)').matches
  document.documentElement.dataset.theme =
    stored === 'light' || stored === 'dark' ? stored : stored === '' && light ? 'light' : 'dark'
})()
