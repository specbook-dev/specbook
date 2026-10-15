import { createEditor, type PrismEditor } from 'prism-code-editor'
import { autoComplete, fuzzyFilter, registerCompletions } from 'prism-code-editor/autocomplete'
import { defaultKeymap, editHistory, editorCommands } from 'prism-code-editor/commands'
import { cursorPosition } from 'prism-code-editor/cursor'
import 'prism-code-editor/languages/json'
import 'prism-code-editor/languages/graphql'
import 'prism-code-editor/prism/languages/json'
import 'prism-code-editor/prism/languages/graphql'
import { useEffect, useRef } from 'preact/hooks'
import type { Completions } from './completions'

/** Per-editor completion providers; one global source dispatches to the editor it was asked about. */
const providers = new WeakMap<PrismEditor, (text: string, pos: number) => Completions | undefined>()

registerCompletions(['json'], {
  sources: [
    (ctx, editor) => {
      const found = providers.get(editor)?.(editor.value, ctx.pos)
      if (!found) return null
      return {
        from: found.from,
        to: found.to,
        options: found.options.map((o) => ({
          ...o,
          renderDocs: o.doc ? () => [o.doc as string] : undefined,
        })),
      }
    },
  ],
})

interface Props {
  value: string
  language?: 'json' | 'graphql' | 'text'
  readOnly?: boolean
  label: string
  onChange?: (value: string) => void
  /** 0-based line the cursor is on */
  onLine?: (line: number) => void
  /** schema-driven suggestions for keys and values (JSON bodies only) */
  complete?: (text: string, pos: number) => Completions | undefined
}

export function BodyEditor({
  value,
  language = 'json',
  readOnly,
  label,
  onChange,
  onLine,
  complete,
}: Props) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<PrismEditor | undefined>(undefined)
  const on = useRef({ onChange, onLine })
  on.current = { onChange, onLine }
  const completer = useRef(complete)
  completer.current = complete

  useEffect(() => {
    const e = createEditor(
      host.current,
      {
        value,
        language,
        readOnly,
        lineNumbers: false,
        wordWrap: true,
        onUpdate: (v) => on.current.onChange?.(v),
        onSelectionChange: (_s, _v, ed) => on.current.onLine?.(ed.activeLine - 1),
      },
      editorCommands(defaultKeymap),
      editHistory(),
      ...(complete ? [cursorPosition(), autoComplete({ filter: fuzzyFilter })] : []),
    )
    if (complete) providers.set(e, (text, pos) => completer.current?.(text, pos))
    e.textarea.setAttribute('aria-label', label)
    editor.current = e
    return () => e.remove()
  }, [])

  useEffect(() => {
    const e = editor.current
    if (e && e.value !== value) e.setOptions({ value })
  }, [value])

  useEffect(() => {
    editor.current?.setOptions({ readOnly, language })
  }, [readOnly, language])

  return <div class="body-editor" part="editor" ref={host} />
}
