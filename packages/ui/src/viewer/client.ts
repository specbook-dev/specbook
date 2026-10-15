import type { OpenResult, Request, Response, Source } from './protocol'
import { startWorker } from './worker-factory'

type Call = Request extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

export type OpenFailure = Error & { code?: 'cors' | 'http' | 'too-large' | 'timeout' | 'parse' }

/** The main thread's handle on the spec worker: one request at a time per id, with progress. */
export class SpecWorker {
  private worker: Worker
  private next = 1
  private pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void; onProgress?: (m: string) => void }
  >()

  constructor() {
    this.worker = startWorker()
    this.worker.addEventListener('message', (e: MessageEvent<Response>) => {
      const m = e.data
      const p = this.pending.get(m.id)
      if (!p) return
      if ('progress' in m) return p.onProgress?.(m.progress)
      this.pending.delete(m.id)
      if (m.ok) p.resolve(m.result)
      else p.reject(Object.assign(new Error(m.error), { code: m.code }) as OpenFailure)
    })
  }

  private call<T>(req: Call, onProgress?: (m: string) => void) {
    const id = this.next++
    return {
      id,
      promise: new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress })
        this.worker.postMessage({ ...req, id } as Request)
      }),
    }
  }

  open(source: Source, onProgress?: (m: string) => void) {
    const { id, promise } = this.call<OpenResult>({ type: 'open', source }, onProgress)
    return { promise, cancel: () => this.worker.postMessage({ type: 'cancel', id } as Request) }
  }

  async bundle(opId: string): Promise<unknown> {
    const json = await this.call<string>({ type: 'bundle', opId }).promise
    return JSON.parse(json)
  }

  async definitions(): Promise<unknown> {
    return JSON.parse(await this.call<string>({ type: 'definitions' }).promise)
  }
}
