/**
 * While the panel is open the page behind it does not scroll. The panel sits in the top layer, which does not stop a wheel
 * or a key over its backdrop from reaching the page, and a page that moves under a dimmed, blurred backdrop is repainted
 * every frame.
 *
 * The host is someone else's page, so what is changed is put back as it was: the inline value, and whether it was
 * `!important`. Only what scrolls from under the panel is locked: the root, and the body when the page made the body its
 * scroller. A scroller further down the page is not an ancestor of the panel, and a wheel over the backdrop cannot reach it.
 */

interface Saved {
  el: HTMLElement
  property: string
  value: string
  priority: string
  /** the element had a style attribute at all, so an empty one left behind can be taken away again */
  hadStyle: boolean
}

let saved: Saved[] | undefined

// the two directions one at a time: the shorthand reads back as nothing when a page set only one of them, and putting
// that back would take the other away too
const hide = (el: HTMLElement, into: Saved[]) => {
  set(el, 'overflow-x', 'hidden', into)
  set(el, 'overflow-y', 'hidden', into)
}

const set = (el: HTMLElement, property: string, value: string, into: Saved[]) => {
  into.push({
    el,
    property,
    value: el.style.getPropertyValue(property),
    priority: el.style.getPropertyPriority(property),
    hadStyle: el.hasAttribute('style'),
  })
  // important, so a host rule that is itself important does not keep the page moving
  el.style.setProperty(property, value, 'important')
}

export function lockScroll() {
  if (saved) return
  const html = document.documentElement
  const body = document.body
  const changes: Saved[] = []
  // with a scrollbar that takes room from the page, removing it would widen the page and shift what is centred in it
  const bar = innerWidth - html.clientWidth > 0
  const bodyScrolls = body && /auto|scroll/.test(getComputedStyle(body).overflowY)
  hide(html, changes)
  if (bar) set(html, 'scrollbar-gutter', 'stable', changes)
  if (bodyScrolls) hide(body, changes)
  saved = changes
}

export function unlockScroll() {
  if (!saved) return
  // in the reverse order they were made
  for (const { el, property, value, priority, hadStyle } of saved.reverse()) {
    if (value) el.style.setProperty(property, value, priority)
    else el.style.removeProperty(property)
    if (!hadStyle && el.getAttribute('style') === '') el.removeAttribute('style')
  }
  saved = undefined
}
