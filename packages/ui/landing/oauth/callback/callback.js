// The return leg of a sign-in on the hosted site. This is the one address people register with an identity
// provider for the hosted viewer, and it is unversioned: the viewer behind it may move from /v1/ to /v2/.
//
// It hands the result to the viewer tab that is waiting and closes. Two ways to reach that tab, because each
// survives what the other does not: a same-origin BroadcastChannel (works when the provider cut
// window.opener) and window.opener.postMessage (works when the viewer is in a cross-site iframe, whose
// channel is partitioned). Plain script, no build; mirrors handleOAuthCallback in src/oauth-callback.ts.
const CHANNEL = 'specbook-oauth'
const ACK_WAIT_MS = 1500

function say(text, withLink) {
  document.getElementById('message').textContent = text
  if (withLink) document.getElementById('more').hidden = false
}

function main() {
  const q = new URLSearchParams(location.search)
  const state = q.get('state')
  if (!state || !(q.has('code') || q.has('error'))) {
    say('Nothing to finish here: a sign-in starts from the Specbook viewer.', true)
    return
  }
  const message = { type: 'callback', state }
  if (q.get('code')) message.code = q.get('code')
  if (q.get('error')) message.error = q.get('error')
  if (q.get('error_description')) message.description = q.get('error_description')

  // single-use, and not for history or a copied address
  history.replaceState(null, '', location.pathname)

  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL)
  let finished = false
  const finish = () => {
    finished = true
    clearTimeout(timer)
    if (channel) channel.close()
    removeEventListener('message', onMessage)
  }
  const claimed = () => {
    if (finished) return
    finish()
    say('Signed in. You can close this window.')
    window.close()
  }
  const isAck = (d) => d && d.type === 'ack' && d.state === state
  const onMessage = (e) => {
    if (e.origin === location.origin && isAck(e.data)) claimed()
  }
  const timer = setTimeout(() => {
    if (finished) return
    finish()
    say('No Specbook window is waiting for this sign-in. Close this window and start again.', true)
  }, ACK_WAIT_MS)

  if (channel) channel.onmessage = (e) => isAck(e.data) && claimed()
  addEventListener('message', onMessage)
  if (channel) channel.postMessage(message)
  try {
    if (window.opener) window.opener.postMessage(message, location.origin)
  } catch {
    // the opener is gone or cross-origin: the channel is the only way
  }
}

main()
