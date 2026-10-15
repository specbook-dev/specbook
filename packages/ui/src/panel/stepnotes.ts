import { useEffect, useMemo, useState } from 'preact/hooks'
import type { SequenceInfo } from '../engine'
import { markdownToHtml } from '../markdown'
import { registry } from '../runtime'

export { type SequenceNotes, splitStepNotes } from './stepnotes-split'

import { type SequenceNotes, splitStepNotes } from './stepnotes-split'

/** The sequence's markdown page (or its description) split into an intro and per-step notes. */
export function useSequenceNotes(info: SequenceInfo): SequenceNotes & { loaded: boolean } {
  const { seq } = info
  const [html, setHtml] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let live = true
    setHtml(undefined)
    setLoaded(false)
    const page = registry.docs.find(
      (d) => d.sequence === seq.meta.id || d.sequenceFile === info.file,
    )
    if (!page) {
      setLoaded(true)
      return
    }
    page
      .load()
      .then((h: string) => live && setHtml(h))
      .finally(() => live && setLoaded(true))
    return () => {
      live = false
    }
  }, [seq.meta.id, info.file])

  const names = useMemo(() => seq.nodes.map((n) => n.name), [seq])
  return useMemo(() => {
    const source = html ?? markdownToHtml(seq.meta.description)
    return { ...splitStepNotes(source, names), loaded }
  }, [html, names, seq, loaded])
}

/** The markdown beside a saved request (`<name>.req.md`), rendered. */
export function useRequestNote(file: string | undefined): string | undefined {
  const [html, setHtml] = useState<string>()
  useEffect(() => {
    let live = true
    setHtml(undefined)
    if (file)
      registry.docs
        .find((d) => d.requestFile === file)
        ?.load()
        .then((h: string) => live && setHtml(h))
    return () => {
      live = false
    }
  }, [file])
  return html
}
