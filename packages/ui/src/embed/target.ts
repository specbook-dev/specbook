// What a page's data attributes ask the play panel to open. Pure, so it is tested in node.

export type EmbedTheme = 'host' | 'auto' | 'light' | 'dark'

export interface Target {
  /** `petstore` of `petstore/GetPetById`; empty when the build has one service and the attribute gave a bare id */
  service?: string
  operation?: string
  /** a saved request, by its project file (`requests/petstore/find-pets.req.ts`) */
  request?: string
  sequence?: string
  example?: string
  /** open on the Docs tab instead of Try */
  tab?: 'docs' | 'try'
  /** preset flow inputs, merged over each input's default */
  inputs?: Record<string, unknown>
  /** why `inputs` was not used */
  problem?: string
  env?: string
  autoRun?: boolean
  theme?: EmbedTheme
}

/** The attributes the panel reads, all namespaced so a host page's own `data-theme` or `data-env` cannot collide. */
export const TRIGGER_SELECTOR = '[data-specbook-try],[data-specbook-flow]'

const THEMES = new Set<string>(['host', 'auto', 'light', 'dark'])

type Attrs = Pick<Element, 'getAttribute' | 'hasAttribute' | 'closest'>

const attr = (el: Attrs, name: string) =>
  el.getAttribute(`data-specbook-${name}`)?.trim() || undefined

/** The nearest ancestor (or the element itself) that sets an attribute, for page-wide defaults like the environment. */
function inherited(el: Attrs, name: string): string | undefined {
  return attr(el.closest(`[data-specbook-${name}]`) ?? el, name)
}

/**
 * Reads one trigger. `data-specbook-try="petstore/GetPetById"` (or a bare `GetPetById`, or a saved request's file)
 * opens a request and `data-specbook-flow="adopt-pet"` a flow; a flow wins when both are given.
 */
export function parseTarget(el: Attrs): Target | undefined {
  const tryValue = attr(el, 'try')
  const flow = attr(el, 'flow')
  if (!tryValue && !flow) return undefined

  const target: Target = {
    example: attr(el, 'example'),
    tab: attr(el, 'tab') === 'docs' ? 'docs' : undefined,
    env: inherited(el, 'env'),
    autoRun: el.hasAttribute('data-specbook-auto-run'),
  }
  const theme = inherited(el, 'theme')
  if (theme && THEMES.has(theme)) target.theme = theme as EmbedTheme

  if (flow) target.sequence = flow
  else if (tryValue) {
    if (/\.req\.ts$/.test(tryValue)) target.request = tryValue
    else {
      const slash = tryValue.indexOf('/')
      if (slash < 0) target.operation = tryValue
      else {
        target.service = tryValue.slice(0, slash)
        target.operation = tryValue.slice(slash + 1)
      }
    }
  }

  const inputs = attr(el, 'inputs')
  if (inputs) {
    try {
      const parsed: unknown = JSON.parse(inputs)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        target.inputs = parsed as Record<string, unknown>
      else target.problem = 'data-specbook-inputs must be a JSON object, such as {"quantity":2}.'
    } catch {
      target.problem = `data-specbook-inputs is not valid JSON: ${inputs}`
    }
  }
  return target
}
