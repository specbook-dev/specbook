// The header's toggle: dark and light, kept under the key Starlight uses so the reference agrees with the rest.
const root = document.documentElement
const button = document.querySelector<HTMLButtonElement>('[data-theme-toggle]')

function set(theme: 'dark' | 'light') {
  root.dataset.theme = theme
  try {
    localStorage.setItem('starlight-theme', theme)
  } catch {
    /* blocked storage: it lasts for this page */
  }
  button?.setAttribute('aria-pressed', String(theme === 'dark'))
  button?.setAttribute(
    'aria-label',
    theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme',
  )
}

button?.addEventListener('click', () => set(root.dataset.theme === 'dark' ? 'light' : 'dark'))
button?.setAttribute('aria-pressed', String(root.dataset.theme === 'dark'))
button?.setAttribute(
  'aria-label',
  root.dataset.theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme',
)
