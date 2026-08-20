/**
 * OIDC discovery. Server-side only.
 *
 * Endpoints are read from the issuer's `/.well-known/openid-configuration`
 * rather than built from provider-specific URL templates, so any spec-compliant
 * provider works (Keycloak, Authentik, Zitadel, Auth0, Entra, Google).
 */

export interface OidcDiscovery {
  token_endpoint: string
  end_session_endpoint?: string
}

let cache: { issuer: string; document: OidcDiscovery } | null = null

export function oidcIssuer(): string {
  const issuer = process.env.OIDC_ISSUER
  if (!issuer) {
    throw new Error('OIDC_ISSUER is not configured')
  }
  return issuer.replace(/\/$/, '')
}

export async function discoverOidc(): Promise<OidcDiscovery> {
  const issuer = oidcIssuer()
  if (cache?.issuer === issuer) {
    return cache.document
  }

  const url = `${issuer}/.well-known/openid-configuration`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`OIDC discovery failed: ${url} returned ${response.status}`)
  }

  const document = (await response.json()) as Partial<OidcDiscovery>
  if (!document.token_endpoint) {
    throw new Error(`OIDC discovery document at ${url} has no token_endpoint`)
  }

  const resolved: OidcDiscovery = {
    token_endpoint: document.token_endpoint,
    end_session_endpoint: document.end_session_endpoint,
  }
  cache = { issuer, document: resolved }
  return resolved
}
