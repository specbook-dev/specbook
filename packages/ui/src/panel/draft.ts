import {
  type Encoding,
  type Example,
  fromFormRows,
  fromRows,
  type Row,
  toFormRows,
  toRows,
} from '@specbook/core/internal'

export type FieldRow = Row & { file?: File }

/** The request as the user sees and edits it. Path/query/headers are grid rows; the body depends on encoding. */
export interface Draft {
  path: Row[]
  query: Row[]
  headers: Row[]
  /** json, graphql and text bodies */
  body: string
  /** form, multipart and binary bodies */
  fields: FieldRow[]
  /**
   * How a form body is edited: nested JSON (the default; flattened to brackets when sent) or the
   * key/value grid. Drafts stored before this existed have only a grid, so they keep it.
   */
  formView?: 'json' | 'grid'
}

/** Whether the body is edited as rows: multipart always, form when its grid view is chosen. */
export const gridMode = (d: Draft, e: Encoding) =>
  e === 'multipart' || (e === 'form' && (d.formView ?? 'grid') === 'grid')

export function draftFrom(ex: Example, encoding: Encoding): Draft {
  const body = ex.body
  const rows = encoding === 'multipart' || encoding === 'form'
  return {
    path: toRows(ex.path),
    query: toRows(ex.query),
    headers: toRows(ex.headers),
    body:
      body === undefined || encoding === 'multipart' || encoding === 'binary'
        ? ''
        : typeof body === 'string' && encoding === 'text'
          ? body
          : JSON.stringify(body, null, 2),
    fields: rows
      ? toFormRows(body)
      : encoding === 'binary' && typeof body === 'string'
        ? [{ key: 'file', value: body, enabled: true }]
        : [],
    formView: encoding === 'form' ? 'json' : undefined,
  }
}

export interface RequestParts {
  path?: Record<string, unknown>
  query?: Record<string, unknown>
  headers?: Record<string, string>
  data?: unknown
}

const nonEmpty = <T extends object>(o: T) => (Object.keys(o).length ? o : undefined)

/** Throws a readable message when the JSON body does not parse. */
export function requestParts(d: Draft, encoding: Encoding): RequestParts {
  let data: unknown
  if (gridMode(d, encoding)) data = fromFormRows(d.fields)
  else if (encoding === 'binary') {
    const f = d.fields.find((r) => r.enabled)
    data = f?.file ?? f?.value
  } else if (d.body.trim() !== '') {
    if (encoding === 'text') data = d.body
    else
      try {
        data = JSON.parse(d.body)
      } catch (e) {
        throw new Error(`Invalid JSON: ${(e as Error).message}`)
      }
  }
  return {
    path: nonEmpty(fromRows(d.path)),
    query: nonEmpty(fromRows(d.query)),
    headers: nonEmpty(fromRows(d.headers)) as Record<string, string> | undefined,
    data,
  }
}

/** The editable state for storage; picked files are never persisted. */
export const forStorage = (d: Draft) => ({
  ...d,
  fields: d.fields.map(({ file: _file, ...r }) => r),
})

/** What the request will be called with, for the URL bar: path params filled in, enabled query rows appended. */
export function previewUrl(template: string, path: Row[], query: Row[], base = ''): string {
  const enc = (v: string) => (v.includes('{{') ? v : encodeURIComponent(v))
  const p = template.replace(/\{([^}]+)\}/g, (m, name: string) => {
    const r = path.find((x) => x.key === name && x.enabled && x.value !== '')
    return r ? enc(r.value) : m
  })
  const qs = query
    .filter((r) => r.enabled && r.key !== '')
    .map((r) => `${enc(r.key)}=${enc(r.value)}`)
    .join('&')
  return `${base.replace(/\/+$/, '')}${p}${qs ? `?${qs}` : ''}`
}
