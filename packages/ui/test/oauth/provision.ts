/**
 * Sets up the realm the suite signs in to, through Keycloak's admin REST API. It runs at the start of every
 * suite and deletes what an earlier run left, so ports (and so redirect URIs) can be chosen at runtime.
 */

export interface Keycloak {
  /** the server, e.g. http://127.0.0.1:8080 */
  url: string
  realm: string
  adminUser: string
  adminPassword: string
}

export const USER = { username: 'tester', password: 'tester-pw' }

/** A public client that uses the authorization code flow with PKCE, for the given page origins. */
export const CLIENT_ID = 'specbook-docs'
/** The same, with no web origins: its token endpoint answers no browser (the CORS-refusal case). */
export const NO_CORS_CLIENT_ID = 'specbook-nocors'

export async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/realms/master/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5_000),
    })
    return r.ok
  } catch {
    return false
  }
}

async function adminToken(kc: Keycloak): Promise<string> {
  const r = await fetch(`${kc.url}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: kc.adminUser,
      password: kc.adminPassword,
    }),
  })
  if (!r.ok) throw new Error(`Keycloak refused the admin login (${r.status}): ${await r.text()}`)
  return ((await r.json()) as { access_token: string }).access_token
}

const client = (clientId: string, redirectOrigins: string[], webOrigins: string[]) => ({
  clientId,
  enabled: true,
  publicClient: true,
  standardFlowEnabled: true,
  implicitFlowEnabled: false,
  directAccessGrantsEnabled: false,
  serviceAccountsEnabled: false,
  redirectUris: redirectOrigins.map((o) => `${o}/*`),
  webOrigins,
  // an authorization request without a PKCE challenge is refused
  attributes: { 'pkce.code.challenge.method': 'S256' },
})

/** (Re)creates the realm with its two clients and one user. `origins` are where the pages run. */
export async function createRealm(kc: Keycloak, origins: string[]): Promise<void> {
  const token = await adminToken(kc)
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  await fetch(`${kc.url}/admin/realms/${kc.realm}`, { method: 'DELETE', headers })

  const body = {
    realm: kc.realm,
    enabled: true,
    // plain http on localhost
    sslRequired: 'none',
    registrationAllowed: false,
    users: [
      {
        username: USER.username,
        enabled: true,
        // Keycloak's profile check puts an "update your account" form into the login without these
        email: 'tester@example.test',
        emailVerified: true,
        firstName: 'Test',
        lastName: 'User',
        credentials: [{ type: 'password', value: USER.password, temporary: false }],
      },
    ],
    clients: [client(CLIENT_ID, origins, origins), client(NO_CORS_CLIENT_ID, origins, [])],
  }
  const r = await fetch(`${kc.url}/admin/realms`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (r.status !== 201)
    throw new Error(`Could not create realm "${kc.realm}" (${r.status}): ${await r.text()}`)
}
