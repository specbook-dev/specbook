import { useEffect, useMemo, useState } from 'preact/hooks'
import { registry } from '../runtime'
import { type Segment, splitIncludes } from './includes'

export interface OperationPage {
  /** the page, cut where it places the blocks the viewer generates */
  segments: Segment[]
  /** the page replaces the spec's description instead of following it */
  replace: boolean
  /** an operation page exists */
  found: boolean
  /** the page has finished loading (or there is none), so what follows it will not move */
  loaded: boolean
}

const NONE = { segments: [], replace: false, found: false }

/** The markdown that sits with an operation (`.../<Operation>/README.md` or `requests/<service>/docs/<Operation>.md`). */
export function useOperationPage(key: string): OperationPage {
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
    return { segments: splitIncludes(html), replace: !!page.replace, found: true, loaded }
  }, [html, page, loaded])
}
