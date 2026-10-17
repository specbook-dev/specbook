import type { Capture } from '../components/Replay'

const found = import.meta.glob<Capture>('../../demo/captures/*.json', {
  eager: true,
  import: 'default',
})

/** A recording made by `docs-demo capture`. A page that names one that is missing fails the build. */
export function capture(name: string): Capture {
  const hit = found[`../../demo/captures/${name}.json`]
  if (!hit)
    throw new Error(`There is no recording "${name}": run \`pnpm --filter docs-demo capture\``)
  return hit
}
