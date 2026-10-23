import type { FieldDoc as Doc } from '../fielddoc'
import { markdownToHtml } from '../markdown'

/** The documentation for the field the cursor is on, shown below the editor instead of beside each line. */
export function FieldDoc({ doc, hint }: { doc?: Doc; hint?: string }) {
  if (!doc)
    return (
      <div class="field-doc empty" part="field-doc" aria-live="polite">
        {hint ?? 'Put the cursor on a field to see what the API says about it.'}
      </div>
    )
  return (
    <div class="field-doc" part="field-doc" aria-live="polite">
      <div class="field-doc-head">
        <code>{doc.path}</code>
        <span class="chip">{doc.type}</span>
        {doc.required && <span class="chip req">required</span>}
        {doc.deprecated && <span class="chip warn">deprecated</span>}
      </div>
      {doc.description ? (
        <div
          class="field-doc-text"
          dangerouslySetInnerHTML={{ __html: markdownToHtml(doc.description) }}
        />
      ) : (
        <p class="muted">
          The spec has no description for this field.
          {doc.parent && <> It is part of: {doc.parent}</>}
        </p>
      )}
      {doc.enum && (
        <p class="field-doc-enum">
          {doc.enum.slice(0, 12).map((v) => (
            <code>{v}</code>
          ))}
          {doc.enum.length > 12 && <span class="muted">+{doc.enum.length - 12} more</span>}
        </p>
      )}
    </div>
  )
}
