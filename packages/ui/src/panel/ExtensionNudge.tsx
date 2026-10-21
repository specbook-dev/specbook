import type { StepResult } from '@specbook/core'
import { useState } from 'preact/hooks'
import { extensionInstallUrl } from '../extension'
import { engine } from '../runtime'
import { env, version } from '../store'

type Hint = NonNullable<StepResult['errorHint']>

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}
/** On Specbook's own sites the extension is there from the start, so "not found" means not installed. */
const onSpecbookSite = () => /(^|\.)specbook\.dev$/.test(globalThis.location?.hostname ?? '')

/**
 * Whether the nudge already says what the failure's own message says, so the message is not shown twice: the
 * extension refused the call, and the nudge puts that in plain words with the button that fixes it. A blocked
 * call is different (the message says why, the nudge says what to do), so both stay.
 */
export const replacesMessage = (hint?: Hint) =>
  !!hint?.origin && (hint.code === 'not-allowed' || hint.code === 'read-only')

/**
 * What the person can do about a failed call, said in the failed response itself and nowhere else: the
 * browser blocked it (the extension can send it), the extension is out of date, or the extension refused it
 * (this page may not call that API yet, or may not modify data there). Nothing is shown for any other
 * failure, and nothing before a call has failed: the extension is an enhancement, never a gate.
 *
 * `services` are the ones the request or flow calls, so one answer in the extension's window can cover every
 * API a flow still needs.
 */
export function ExtensionNudge({ hint, services }: { hint?: Hint; services?: string[] }) {
  const [asked, setAsked] = useState(false)
  const origin = hint?.origin
  if (!hint || !origin) return null
  const host = hostOf(origin)
  const installUrl = extensionInstallUrl()

  const ask = async (writes: boolean) => {
    setAsked(true)
    if (writes) return void engine.requestExtensionGrant([origin], { writes: true })
    const state = await engine
      .extensionState(env.value, version.value, services)
      .catch(() => undefined)
    void engine.requestExtensionGrant([...new Set([origin, ...(state?.missing ?? [])])])
  }
  // what to do in the extension's window differs: allow an API, or tick the box on one already allowed
  const thenRunAgain = (what: string) =>
    asked ? ` ${what} in the extension’s window, then run it again.` : ''

  switch (hint.code) {
    case 'cors':
      // nothing to install here (Firefox, Safari, a phone): never a dead link
      if (!installUrl) return null
      return (
        <p class="ext-nudge" role="status">
          The Specbook extension can send this call for you, past the browser’s block on {host}.{' '}
          <a href={installUrl} target="_blank" rel="noreferrer">
            Get the extension
          </a>
          {onSpecbookSite()
            ? '. After installing it, reload this page.'
            : ', or if it is installed, click its toolbar icon and choose Enable.'}
        </p>
      )
    case 'outdated':
      return (
        <p class="ext-nudge" role="status">
          The Specbook extension is out of date, so it was not used for {host}.
          {installUrl ? (
            <>
              {' '}
              <a href={installUrl} target="_blank" rel="noreferrer">
                Update it
              </a>
              .
            </>
          ) : null}
        </p>
      )
    case 'not-allowed':
      return (
        <div class="ext-nudge ext-nudge-action" role="status">
          <span>
            This page has not been allowed to call {host} through the Specbook extension.
            {thenRunAgain('Choose Allow')}
          </span>
          <button type="button" class="btn" onClick={() => void ask(false)}>
            Allow
          </button>
        </div>
      )
    case 'read-only':
      return (
        <div class="ext-nudge ext-nudge-action" role="status">
          <span>
            This page can read {host} through the Specbook extension, but has not been allowed to
            modify data there.{thenRunAgain('Tick Modify data')}
          </span>
          <button type="button" class="btn" onClick={() => void ask(true)}>
            Allow modifying data
          </button>
        </div>
      )
    default:
      return null
  }
}
