// Every page: registers the service worker that is the demo API. A Run button that uses the demo environment waits for it,
// for the moment that takes on a first visit, and then works either way: if the browser will not have a worker, the panel
// shows the request failing rather than a button that does nothing.
import { demoReady } from '../../demo/server/client'

const labels = {
  ready: 'Demo API running in this page',
  unsupported: 'The demo API needs a service worker, which this browser is not allowing here',
  bypassed: 'The demo API is paused: reload the page to start it',
} as const

/** The buttons that send to the demo API: the environment is set on the button or on something around it. */
const usesDemo = (b: HTMLElement) =>
  b.closest('[data-specbook-env]')?.getAttribute('data-specbook-env') === 'demo'
const triggers = () =>
  [
    ...document.querySelectorAll<HTMLButtonElement>(
      'button[data-specbook-try], button[data-specbook-flow]',
    ),
  ].filter(usesDemo)

for (const b of triggers()) b.disabled = true

const status = await demoReady()
document.documentElement.dataset.demo = status

for (const b of triggers()) {
  b.disabled = false
  if (status !== 'ready') b.title = labels[status]
}
