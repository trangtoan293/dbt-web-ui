import type { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface Session {
    accessToken?: string
    idToken?: string
    error?: string
    user: {
      id: string
      // Convenience only, for showing/hiding UI - never a source of truth for
      // authorization. Every mutation re-reads users.role from Postgres at
      // request time (nextjs/src/lib/authz.ts); dbt-runner does the same
      // independently. See docs/rbac-design.md.
      role: string
    } & DefaultSession['user']
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    accessToken?: string
    idToken?: string
    refreshToken?: string
    accessTokenExpiresAt?: number
    userId?: string
    role?: string
    error?: string
  }
}
