import type { ScriptBody } from '@specbook/core'
import type { Inputs } from './turnstile.script'

// the widget as Cloudflare documents it: `render=explicit` leaves the page to say where it goes
const API = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

interface Turnstile {
  render(
    container: Element,
    options: {
      sitekey: string
      size: 'normal' | 'compact' | 'flexible'
      callback(token: string): void
      'error-callback'(code: string): void
      'expired-callback'(): void
    },
  ): string
  remove(widgetId: string): void
}

// #region body
/** What the body returns: the token the widget gives, and the key it was given for. */
export type Output = { token: string; siteKey: string }

/** Shows the widget in the step's row and waits for it to give a token. */
export const run: ScriptBody<Inputs, Output> = async ({ siteKey }, h) => {
  const api = await h.loadScript<Turnstile>(API, { global: 'turnstile' })
  const stage = await h.mount()
  h.log(`showing the widget for ${siteKey}`)
  return new Promise<Output>((resolve, reject) => {
    // however the step ends, take the widget down, so a second Run starts with none registered in the SDK
    const end = (settle: () => void) => () => {
      api.remove(id)
      settle()
    }
    const id = api.render(stage, {
      sitekey: siteKey,
      size: 'normal',
      callback: (token) => end(() => resolve({ token, siteKey }))(),
      'error-callback': (code) =>
        end(() => reject(new Error(`Turnstile failed with error ${code}.`)))(),
      'expired-callback': end(() => reject(new Error('The token expired before it was used.'))),
    })
    // Stop in the panel ends the step too
    h.signal.addEventListener(
      'abort',
      end(() => reject(new Error('Stopped before it passed.'))),
    )
  })
}
// #endregion body
