const KEY = 'specbook:recent-specs'
const MAX = 10

export function recentSpecs(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, MAX) : []
  } catch {
    return []
  }
}

export function rememberSpec(url: string) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify([url, ...recentSpecs().filter((u) => u !== url)].slice(0, MAX)),
    )
  } catch {
    /* private mode: nothing to remember with */
  }
}
