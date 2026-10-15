import { useEffect, useMemo, useState } from 'preact/hooks'
import { registry } from '../runtime'
import { type FieldNotes, splitFieldNotes } from './fieldnotes-split'

export { type FieldNotes, type FieldSection, noteKey, splitFieldNotes } from './fieldnotes-split'

export interface OperationNotes extends FieldNotes {
  /** the page replaces the spec's description instead of following it */
  replace: boolean
  /** an operation page exists */
  found: boolean
  /** the page has finished loading (or there is none), so what follows it will not move */
  loaded: boolean
}

const NONE = { intro: '', notes: new Map(), replace: false, found: false }

/** The markdown that sits with an operation (`.../<Operation>/README.md` or `requests/<service>/docs/<Operation>.md`), split into intro and field notes. */
export function useOperationNotes(key: string): OperationNotes {
  const [html, setHtml] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  const page = registry.docs.find((d) => d.operation === key)
  useEffect(() => {
    let live = true
    setHtml(undefined)
    setLoaded(!page)
    page
      ?.load()
      .then((h: string) => live && setHtml(h))
      .catch(() => {})
      .finally(() => live && setLoaded(true))
    return () => {
      live = false
    }
  }, [key, page])
  return useMemo(() => {
    if (!page || html === undefined) return { ...NONE, loaded }
    return { ...splitFieldNotes(html), replace: !!page.replace, found: true, loaded }
  }, [html, page, loaded])
}
