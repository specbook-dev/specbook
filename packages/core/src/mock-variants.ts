/**
 * A status's example file is usually one body. When the spec gives several (named `examples`, or a response that is a
 * `oneOf`), `generate` writes them all into that one file, so the mock can answer with any:
 *
 *     { "$variants": [{ "name": "OutOfStock", "title": "Out of stock", "tag": "OUT_OF_STOCK", "body": { … } }, …] }
 *
 * Anything else is a bare body, as before. The first variant is the default.
 */
export const MOCK_VARIANTS = '$variants'

export interface MockVariant {
  /** unique within the file; what a request or a mock hook names */
  name: string
  /** the way a person reads the name (a spec example's `summary`) */
  title?: string
  /** the value of the property that tells the variants apart, when there is one */
  tag?: string
  body: unknown
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Whether an example file holds variants: an object whose only key is `$variants`, a list of `{ name, body }`. */
export function isMockVariants(file: unknown): file is { $variants: MockVariant[] } {
  if (!isObject(file)) return false
  const keys = Object.keys(file)
  const list = file[MOCK_VARIANTS]
  return (
    keys.length === 1 &&
    Array.isArray(list) &&
    list.length > 0 &&
    list.every((v) => isObject(v) && typeof v.name === 'string' && 'body' in v)
  )
}

/** The names a file offers, in order (none for a bare body). */
export function mockVariantNames(file: unknown): string[] {
  return isMockVariants(file) ? file.$variants.map((v) => v.name) : []
}

/**
 * The body an example file answers with: the variant `name` when the file has one by that name, else the first, and a
 * bare body as it is.
 */
export function pickMockVariant(file: unknown, name?: string): unknown {
  if (!isMockVariants(file)) return file
  const list = file.$variants
  return (list.find((v) => v.name === name) ?? (list[0] as MockVariant)).body
}
