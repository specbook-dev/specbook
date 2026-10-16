import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import { env, environmentNote, environments } from '../store'

interface Props {
  title: string
  subtitle?: string
  /** the body fills the panel and manages its own scrolling */
  flush?: boolean
  /** dims the page and traps focus (embeds); the standalone site leaves its list usable beside the panel */
  modal?: boolean
  onPrev?: () => void
  onNext?: () => void
  onClose: () => void
  children: ComponentChildren
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The three-quarter sheet from the right where requests and sequences run. */
export function Panel({
  title,
  subtitle,
  flush,
  modal = true,
  onPrev,
  onNext,
  onClose,
  children,
}: Props) {
  const aside = useRef<HTMLElement>(null)

  useEffect(() => {
    const root = aside.current?.getRootNode() as Document | ShadowRoot
    const before = root?.activeElement as HTMLElement | null
    if (modal) aside.current?.focus()
    return () => before?.focus?.()
  }, [modal])

  // The keyboard hides the lower half of a phone's screen and iOS does not reliably scroll a field in
  // a fixed panel above it. While a text field is focused its scroller gets room under the content,
  // and the field is placed near the top of the panel, which the keyboard never covers.
  useEffect(() => {
    const el = aside.current
    if (!el || typeof matchMedia === 'undefined') return
    const phone = matchMedia('(max-width: 820px)')
    const FIELD = 'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea'
    let padded: { box: HTMLElement; was: string } | undefined
    let timers: number[] = []
    const scroller = (from: HTMLElement) => {
      for (let n = from.parentElement; n && n !== el; n = n.parentElement) {
        const y = getComputedStyle(n).overflowY
        if (y === 'auto' || y === 'scroll') return n
      }
      return null
    }
    const place = (field: HTMLElement) => {
      const box = scroller(field)
      if (!box) return
      // measured against what is visible: iOS pans its visual viewport under the keyboard
      const vv = typeof visualViewport === 'undefined' ? undefined : visualViewport
      const top = vv?.offsetTop ?? 0
      const height = vv?.height ?? innerHeight
      const at = field.getBoundingClientRect().top
      // a dropdown field needs its list visible too, and picking from it needs no keyboard: it is moved
      // only when it is down where the keyboard would be, and not as far
      const dropdown = field.getAttribute('role') === 'combobox'
      const want = top + height * (dropdown ? 0.3 : 0.2)
      if (at > top + height * (dropdown ? 0.55 : 0.4) || at < top) box.scrollTop += at - want
    }
    const focusin = (e: Event) => {
      const field = e.target as HTMLElement
      if (!phone.matches || !field.matches?.(FIELD)) return
      const box = scroller(field)
      // a dropdown field high enough on the screen is not moved, so it needs no room below (which would
      // only show a scrollbar)
      const vv = typeof visualViewport === 'undefined' ? undefined : visualViewport
      const low =
        field.getBoundingClientRect().top >
        (vv?.offsetTop ?? 0) + (vv?.height ?? innerHeight) * 0.55
      if (box && padded?.box !== box && (field.getAttribute('role') !== 'combobox' || low)) {
        if (padded) padded.box.style.paddingBottom = padded.was
        padded = { box, was: box.style.paddingBottom }
        box.style.paddingBottom = '70vh'
      }
      // the keyboard animates in; place the field as it opens and again once it has settled
      for (const t of timers) clearTimeout(t)
      timers = [0, 150, 400, 800].map((ms) => window.setTimeout(() => place(field), ms))
    }
    const focusout = () => {
      timers.push(
        window.setTimeout(() => {
          const at = (el.getRootNode() as Document | ShadowRoot).activeElement
          if (at?.matches?.(FIELD) || !padded) return
          padded.box.style.paddingBottom = padded.was
          padded = undefined
        }, 200),
      )
    }
    el.addEventListener('focusin', focusin)
    el.addEventListener('focusout', focusout)
    return () => {
      el.removeEventListener('focusin', focusin)
      el.removeEventListener('focusout', focusout)
      for (const t of timers) clearTimeout(t)
      if (padded) padded.box.style.paddingBottom = padded.was
    }
  }, [])

  // A layout effect, so the keys work from the moment the panel is on screen: an effect waits for the next
  // frame, and a key pressed (or sent by a test, or a host page) before it was ignored
  useLayoutEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key !== 'Tab' || !modal || !aside.current) return
      const items = [...aside.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null,
      )
      const first = items[0]
      const last = items[items.length - 1]
      const root = aside.current.getRootNode() as Document | ShadowRoot
      const at = root.activeElement
      if (!first || !last) return
      if (e.shiftKey && (at === first || at === aside.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && at === last) {
        e.preventDefault()
        first.focus()
      }
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [onClose, modal])

  // a dialog when it dims the page (embeds), a complementary region when docked beside the list
  const attrs = {
    class: `panel ${modal ? '' : 'docked'}`,
    part: 'panel',
    'aria-label': title,
    'aria-modal': modal ? true : undefined,
    role: (modal ? 'dialog' : 'complementary') as 'dialog',
    tabIndex: -1,
  }

  return (
    <>
      {modal && (
        <button type="button" class="panel-backdrop" aria-label="Close" onClick={onClose} />
      )}
      <section {...attrs} ref={aside}>
        <header class="panel-head" part="header">
          <div class="panel-title">
            <h2>{title}</h2>
            {subtitle && <div class="muted small">{subtitle}</div>}
          </div>
          <span class="spacer" />
          {modal && environments.value.length > 1 && (
            <label class="row">
              <span class="muted">Environment</span>
              <select
                value={env.value}
                onChange={(e) => (env.value = (e.target as HTMLSelectElement).value)}
              >
                {environments.value.map((e) => (
                  <option value={e} title={environmentNote.value[e]}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(onPrev || onNext) && (
            <span class="stepper">
              <button
                type="button"
                class="icon"
                title="Previous"
                aria-label="Previous"
                disabled={!onPrev}
                onClick={onPrev}
              >
                ↑
              </button>
              <button
                type="button"
                class="icon"
                title="Next"
                aria-label="Next"
                disabled={!onNext}
                onClick={onNext}
              >
                ↓
              </button>
            </span>
          )}
          <button type="button" class="icon" aria-label="Close panel" onClick={onClose}>
            ×
          </button>
        </header>
        <div class={`panel-body ${flush ? 'flush' : ''}`}>{children}</div>
      </section>
    </>
  )
}
