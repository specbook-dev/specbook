import { describe, expect, it } from 'vitest'
import { CALL_CHANNEL, createRelay, type Link, REPLY_CHANNEL } from '../src/relay'

/** A line to the worker that a test drives from both ends. */
function fakeLink() {
  let onMessage: (m: unknown) => void = () => undefined
  let onClose: () => void = () => undefined
  const sent: unknown[] = []
  const link: Link & { closed: boolean } = {
    closed: false,
    post: (m) => sent.push(m),
    onMessage: (cb) => {
      onMessage = cb
    },
    onClose: (cb) => {
      onClose = cb
    },
    close() {
      link.closed = true
    },
  }
  return {
    link,
    sent,
    workerReplies: (m: unknown) => onMessage(m),
    workerGoesAway: () => onClose(),
  }
}

function setup() {
  const toPage: { channel: string; reply: unknown }[] = []
  const links: ReturnType<typeof fakeLink>[] = []
  const relay = createRelay({
    toPage: (m) => toPage.push(m),
    connect: () => {
      const l = fakeLink()
      links.push(l)
      return l.link
    },
  })
  return { relay, toPage, links }
}

const msg = (call: unknown) => ({ channel: CALL_CHANNEL, call })
const fetchCall = {
  v: 1,
  type: 'fetch',
  id: 'c1',
  req: { method: 'GET', url: 'https://a.example/x', headers: {} },
}

describe('the relay between a page and the worker', () => {
  it('answers a ping itself, without opening a line to the worker', () => {
    const { relay, toPage, links } = setup()
    relay(msg({ v: 1, type: 'ping' }))
    expect(links).toHaveLength(0)
    expect(toPage).toEqual([{ channel: REPLY_CHANNEL, reply: { v: 1, type: 'pong', version: 1 } }])
  })

  it('ignores what is not for it or is not well formed', () => {
    const { relay, toPage, links } = setup()
    relay(null)
    relay('hello')
    relay({ channel: 'something-else', call: { v: 1, type: 'ping' } })
    relay(msg({ v: 2, type: 'ping' }))
    relay(
      msg({
        v: 1,
        type: 'fetch',
        id: 'c',
        req: { method: 'GET', url: 'file:///etc/passwd', headers: {} },
      }),
    )
    expect(links).toHaveLength(0)
    expect(toPage).toHaveLength(0)
  })

  it('gives each fetch its own line, hands on the validated call, and relays the one reply', () => {
    const { relay, toPage, links } = setup()
    relay(msg({ ...fetchCall, evil: 'dropped' }))
    expect(links).toHaveLength(1)
    expect(links[0]?.sent).toEqual([{ call: fetchCall }])
    links[0]?.workerReplies({
      reply: { v: 1, type: 'response', id: 'c1', res: { status: 200, headers: {} } },
    })
    expect(toPage).toHaveLength(1)
    expect(toPage[0]?.reply).toMatchObject({ type: 'response', id: 'c1' })
    expect(links[0]?.link.closed).toBe(true)
  })

  it('closes the line for a call the page aborts', () => {
    const { relay, links } = setup()
    relay(msg(fetchCall))
    relay(msg({ v: 1, type: 'abort', id: 'c1' }))
    expect(links[0]?.link.closed).toBe(true)
  })

  it('tells the page when the worker went away without answering, so it does not wait for ever', () => {
    const { relay, toPage, links } = setup()
    relay(msg(fetchCall))
    links[0]?.workerGoesAway()
    expect(toPage[0]?.reply).toMatchObject({ type: 'error', id: 'c1', code: 'network' })
  })

  it('does not report an error for a line that closed after its reply', () => {
    const { relay, toPage, links } = setup()
    relay(msg(fetchCall))
    links[0]?.workerReplies({
      reply: { v: 1, type: 'response', id: 'c1', res: { status: 204, headers: {} } },
    })
    links[0]?.workerGoesAway()
    expect(toPage).toHaveLength(1)
  })

  it('uses a line for status and grant too, and relays their reply', () => {
    const { relay, toPage, links } = setup()
    relay(msg({ v: 1, type: 'status', apiOrigins: ['https://a.example'] }))
    expect(links).toHaveLength(1)
    links[0]?.workerReplies({
      reply: { v: 1, type: 'status', granted: [], missing: ['https://a.example'] },
    })
    expect(toPage[0]?.reply).toMatchObject({ type: 'status' })
  })
})
