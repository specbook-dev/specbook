import type { ScriptBody } from '@specbook/core'
import type { Inputs } from './approve.script'

// #region body
/** What the body returns: the next step reads it as `ctx.captured.<name>`, and the mock in the contract answers with it. */
export type Output = { approvedAt: string; amount: number; currency: 'USD' | 'EUR' }

/**
 * The body: it runs in the portal when the step does. It renders into the container the step's row gives it (never a
 * selector: the project embed lives in a shadow root) and waits for the person, as a payment SDK's button would.
 */
export const run: ScriptBody<Inputs, Output> = async ({ amount, currency }, h) => {
  const stage = await h.mount()
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = `Approve ${amount} ${currency}`
  stage.append(button)
  h.log(`asked to approve ${amount} ${currency}`)
  await new Promise<void>((approved, stopped) => {
    button.addEventListener('click', () => approved(), { once: true })
    // Stop in the panel ends the step: the script says so rather than leaving a button that does nothing
    h.signal.addEventListener('abort', () => stopped(new Error('Stopped before it was approved.')))
  })
  button.disabled = true
  return { approvedAt: new Date().toISOString(), amount, currency }
}
// #endregion body
