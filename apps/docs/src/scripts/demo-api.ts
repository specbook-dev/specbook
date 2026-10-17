// Every page: registers the service worker that is the demo API, and tells the page whether it can be used. A Run button
// waits for it, and a page that cannot have it says why instead of failing quietly.
import { demoReady, onDemoChange, resetDemo } from '../../demo/server/client'

const labels = {
  ready: 'Demo API running in this page',
  unsupported: 'Demo API unavailable: this browser blocks service workers',
  bypassed: 'Demo API paused: reload the page to start it',
} as const

const triggers = () =>
  document.querySelectorAll<HTMLButtonElement>(
    'button[data-specbook-try], button[data-specbook-flow]',
  )

// a Run button does nothing until there is an API to run against
for (const b of triggers()) b.disabled = true

const status = await demoReady()
document.documentElement.dataset.demo = status

for (const chip of document.querySelectorAll<HTMLElement>('[data-demo-status]')) {
  chip.dataset.state = status
  const label = chip.querySelector('.label')
  if (label) label.textContent = labels[status]
}
for (const b of triggers()) {
  b.disabled = status !== 'ready'
  if (status !== 'ready') b.title = labels[status]
}
for (const reload of document.querySelectorAll<HTMLElement>('[data-demo-reload]')) {
  reload.hidden = status !== 'bypassed'
  reload.addEventListener('click', () => location.reload())
}
for (const reset of document.querySelectorAll<HTMLButtonElement>('[data-demo-reset]')) {
  reset.disabled = status !== 'ready'
  reset.addEventListener('click', async () => {
    reset.disabled = true
    await resetDemo()
    reset.textContent = 'Reset ✓'
    setTimeout(() => {
      reset.textContent = 'Reset the demo data'
      reset.disabled = false
    }, 1500)
  })
}
onDemoChange(() => {
  // another page changed the demo: nothing to redraw yet, the controls read the API when they need it
})
