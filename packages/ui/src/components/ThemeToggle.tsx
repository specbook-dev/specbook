import { cycleTheme, type Theme, theme } from '../theme'

const LABEL: Record<Theme, string> = {
  auto: 'Theme: follows your system. Click for light.',
  light: 'Theme: light. Click for dark.',
  dark: 'Theme: dark. Click to follow your system.',
}

const Icon = ({ mode }: { mode: Theme }) => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {mode === 'light' && (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </>
    )}
    {mode === 'dark' && <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" />}
    {mode === 'auto' && (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none" />
      </>
    )}
  </svg>
)

/** Light / dark / follow the system, remembered in this browser. */
export function ThemeToggle() {
  const t = theme.value
  return (
    <button
      type="button"
      class="icon theme-toggle"
      title={LABEL[t]}
      aria-label={LABEL[t]}
      data-theme-mode={t}
      onClick={cycleTheme}
    >
      <Icon mode={t} />
    </button>
  )
}
