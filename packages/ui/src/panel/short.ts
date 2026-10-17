/**
 * A value as text, whatever it is. A run hands the page whatever the project's code and the API produced, and JSON cannot
 * write all of it: `undefined` and functions come back as nothing, a circular object or a BigInt throws. A line that cannot
 * be drawn must not stop the panel, so this never throws and never returns nothing.
 */
export function show(v: unknown, space?: number): string {
  try {
    const s = JSON.stringify(v, null, space)
    if (s !== undefined) return s
  } catch {
    /* circular, or something JSON has no form for: name it instead */
  }
  try {
    return String(v)
  } catch {
    return Object.prototype.toString.call(v)
  }
}

/** A value for a line of text: its text, cut at 28 characters. */
export function short(v: unknown): string {
  const s = typeof v === 'string' ? v : show(v)
  return s.length > 28 ? `${s.slice(0, 27)}…` : s
}
