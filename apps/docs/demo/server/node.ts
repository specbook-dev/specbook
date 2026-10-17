import { serve } from '@hono/node-server'
import { createDemoApp, type DemoOptions } from './app'
import { memoryStore } from './store'

export interface RunningDemo {
  /** `http://127.0.0.1:<port>` */
  origin: string
  close(): Promise<void>
}

/**
 * The demo API on a port of this machine: what a test or a recording talks to, the same app the service worker serves.
 * Port 0 takes any free one.
 */
export function start(port = 0, options: Partial<DemoOptions> = {}): Promise<RunningDemo> {
  const app = createDemoApp({ store: memoryStore(), ...options })
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) =>
      resolve({
        origin: `http://127.0.0.1:${info.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      }),
    )
  })
}
