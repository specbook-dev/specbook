// The shared definitions a service's schemas refer to, for a build that publishes only some of its operations.

/** Names of the shared definitions a JSON text refers to (`specbook://<svc>/defs#/$defs/Name` or `#/$defs/Name`). */
export function definitionRefs(text: string): string[] {
  const names: string[] = []
  for (const m of text.matchAll(/"\$ref":"(?:specbook:\/\/[^"#]*)?#\/\$defs\/([^"]+)"/g))
    names.push((m[1] as string).replace(/~1/g, '/').replace(/~0/g, '~'))
  return names
}

/** A service's definitions cut down to the ones `roots` refer to, directly or through each other. */
export function pruneDefinitions(
  defs: { $id?: string; $defs?: Record<string, unknown> },
  roots: Set<string> | undefined,
) {
  const all = defs.$defs ?? {}
  const keep = new Set<string>()
  const queue = [...(roots ?? [])]
  while (queue.length) {
    const name = queue.pop() as string
    if (keep.has(name) || !(name in all)) continue
    keep.add(name)
    queue.push(...definitionRefs(JSON.stringify(all[name])))
  }
  return { ...defs, $defs: Object.fromEntries(Object.entries(all).filter(([k]) => keep.has(k))) }
}
