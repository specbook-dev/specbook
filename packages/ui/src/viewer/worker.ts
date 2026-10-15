/// <reference lib="webworker" />
import { generateData, type OperationMeta, openSpec } from '@specbook/codegen/browser'
import { authFromSpec, liveBaseUrl } from '@specbook/core'
import { bundleJson, type Parts, sortFiles } from './bundles'
import type { OpenResult, Request, Response, Source } from './protocol'

const MAX_BYTES = 25 * 1024 * 1024
const TIMEOUT_MS = 30_000

const post = (r: Response) => (self as unknown as Worker).postMessage(r)

let parts: Parts | undefined
const aborts = new Map<number, AbortController>()

class Failure extends Error {
  constructor(
    message: string,
    readonly code?: 'cors' | 'http' | 'too-large' | 'timeout' | 'parse',
  ) {
    super(message)
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'api'

/** The document's bytes, read as a stream so a cap applies before it is all in memory. */
async function download(url: string, signal: AbortSignal): Promise<string> {
  let res: globalThis.Response
  try {
    res = await fetch(url, { signal, redirect: 'follow', credentials: 'omit' })
  } catch {
    if (signal.aborted) throw new Failure('The server took too long to answer.', 'timeout')
    throw new Failure(
      'The browser could not read that address. The server may not allow requests from other sites (CORS), or the address is not reachable from here.',
      'cors',
    )
  }
  if (!res.ok) throw new Failure(`The server answered ${res.status} for that address.`, 'http')
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_BYTES) throw new Failure('That document is larger than 25 MB.', 'too-large')
  const reader = res.body?.getReader()
  if (!reader) return res.text()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > MAX_BYTES) {
      await reader.cancel()
      throw new Failure('That document is larger than 25 MB.', 'too-large')
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let o = 0
  for (const c of chunks) {
    all.set(c, o)
    o += c.length
  }
  return new TextDecoder().decode(all)
}

async function open(id: number, source: Source, signal: AbortSignal): Promise<OpenResult> {
  const t0 = performance.now()
  let text: string
  let fetched: number | undefined
  let name: string | undefined
  if (source.kind === 'url') {
    post({ id, progress: 'Fetching the document…' })
    const t = performance.now()
    text = await download(source.url, signal)
    fetched = performance.now() - t
    name = source.url
  } else {
    text = source.text
    name = source.name
  }
  post({ id, progress: 'Reading the document…' })
  const tParse = performance.now()
  let opened: Awaited<ReturnType<typeof openSpec>>
  try {
    opened = await openSpec(text)
  } catch (e) {
    throw new Failure(e instanceof Error ? e.message : String(e), 'parse')
  }
  const parse = performance.now() - tParse
  const { doc, warnings } = opened

  post({ id, progress: 'Preparing operations…' })
  const title = (doc.info?.title as string | undefined) ?? 'API'
  const service = slug(title)
  const tGen = performance.now()
  const generated = generateData(doc, { service })
  const generate = performance.now() - tGen

  parts = sortFiles(generated.files)
  const manifest = JSON.parse(parts.manifest) as Record<string, any>
  const slim = {
    ...manifest,
    operations: manifest.operations.map(
      ({ description: _d, examples: _e, file: _f, ...o }: Record<string, unknown>) => o,
    ),
  }
  const exampleNames = Object.fromEntries(
    manifest.operations.map((o: any) => [
      o.id,
      (o.examples as { name: string }[]).map((e) => e.name),
    ]),
  )
  const sourceUrl = source.kind === 'url' ? source.url : undefined
  const { auth, secrets, defaultProfile } = authFromSpec(doc, sourceUrl)
  const baseUrl = liveBaseUrl(doc, sourceUrl ?? name ?? '')
  const relativeServer =
    typeof doc.servers?.[0]?.url === 'string' && !/^https?:\/\//i.test(doc.servers[0].url)
  return {
    service,
    title,
    manifest: slim,
    metas: generated.metas as unknown as Record<string, Record<string, unknown>>,
    exampleNames,
    auth,
    secrets,
    defaultProfile,
    baseUrl,
    needsBaseUrl: !baseUrl && relativeServer,
    warnings,
    timings: {
      ...(fetched !== undefined ? { fetch: Math.round(fetched) } : {}),
      parse: Math.round(parse),
      generate: Math.round(generate),
      total: Math.round(performance.now() - t0),
    },
    bytes: { spec: text.length, definitions: parts.definitions.length },
  }
}

self.addEventListener('message', async (e: MessageEvent<Request>) => {
  const m = e.data
  try {
    if (m.type === 'cancel') {
      aborts.get(m.id)?.abort()
      return
    }
    if (m.type === 'bundle') {
      return post({ id: m.id, ok: true, result: bundleJson(parts?.ops.get(m.opId)) })
    }
    if (m.type === 'definitions') {
      return post({ id: m.id, ok: true, result: parts?.definitions ?? '{}' })
    }
    const ctl = new AbortController()
    aborts.set(m.id, ctl)
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    try {
      const result = await open(m.id, m.source, ctl.signal)
      post({ id: m.id, ok: true, result })
    } finally {
      clearTimeout(timer)
      aborts.delete(m.id)
    }
  } catch (err) {
    if (err instanceof Failure) post({ id: m.id, ok: false, error: err.message, code: err.code })
    else post({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

export type { OperationMeta }
