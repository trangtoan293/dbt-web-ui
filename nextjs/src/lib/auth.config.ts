import type { NextAuthConfig } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { AUTH_DISABLED, LOCAL_USER } from '@/lib/auth-constants'

// Generic OIDC provider: endpoints come from the issuer's discovery document,
// so this works with any spec-compliant IdP (Keycloak, Authentik, Zitadel,
// Auth0, Entra, Google) without provider-specific code.
const oidcProvider = {
  id: 'oidc',
  name: process.env.OIDC_PROVIDER_NAME || 'SSO',
  type: 'oidc' as const,
  issuer: process.env.OIDC_ISSUER,
  clientId: process.env.OIDC_CLIENT_ID,
  clientSecret: process.env.OIDC_CLIENT_SECRET,
}

const providers = AUTH_DISABLED
  ? [
      // No-auth mode: auto-authorize a single local user. No external IdP.
      Credentials({
        id: 'credentials',
        name: 'Local',
        credentials: {},
        authorize: async () => ({ id: LOCAL_USER.sub, email: LOCAL_USER.email, name: LOCAL_USER.name }),
      }),
    ]
  : [oidcProvider]

export const authConfig = {
  providers,
  session: {
    strategy: 'jwt',
  },
  // Without these, Auth.js falls back to its own unstyled pages at
  // /api/auth/signin and /api/auth/error. Anything it initiates itself — an
  // auth error, or signIn() with an unknown provider id — lands there instead
  // of on our page, showing a raw "Sign in with <provider name>" button.
  pages: {
    signIn: '/login',
    error: '/login',
  },
} satisfies NextAuthConfig
