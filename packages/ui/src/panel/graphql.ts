export interface Graphql {
  query: string
  variables: string
  rest: Record<string, unknown>
}

/** A GraphQL body is `{ query, variables?, operationName? }`; split it so each part gets its own editor. */
export function splitGraphql(body: string): Graphql | undefined {
  try {
    const { query, variables, ...rest } = JSON.parse(body)
    if (typeof query !== 'string') return undefined
    return {
      query,
      variables: variables === undefined ? '' : JSON.stringify(variables, null, 2),
      rest,
    }
  } catch {
    return undefined
  }
}

export function joinGraphql(g: Graphql): string {
  let variables: unknown
  try {
    variables = g.variables.trim() ? JSON.parse(g.variables) : undefined
  } catch {
    // keep what was typed so the body stays editable; the panel reports invalid JSON
    variables = g.variables
  }
  return JSON.stringify({ query: g.query, variables, ...g.rest }, null, 2)
}
