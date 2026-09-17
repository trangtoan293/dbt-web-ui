import NextAuth, { type NextAuthConfig } from 'next-auth'
import { Prisma } from '@prisma/client'
import { authConfig } from '@/lib/auth.config'
import { AUTH_DISABLED, LOCAL_USER } from '@/lib/auth-constants'
import { refreshAccessToken } from '@/lib/auth-refresh'
import { db } from '@/lib/db'

const ACCESS_TOKEN_REFRESH_BUFFER_SECONDS = 60

async function ensureLocalUser() {
  return db.user.upsert({
    where: { oidcSub: LOCAL_USER.sub },
    update: { name: LOCAL_USER.name },
    create: {
      oidcSub: LOCAL_USER.sub,
      email: LOCAL_USER.email,
      name: LOCAL_USER.name,
    },
  })
}

async function ensureOidcUser(sub: string, email: string, name: string | null | undefined) {
  try {
    return await db.user.upsert({
      where: { oidcSub: sub },
      update: { name: name ?? null },
      create: { oidcSub: sub, email, name: name ?? null },
    })
  } catch (error) {
    // Preserve the existing account-linking behavior when the provider rotates
    // a subject but keeps the same email. The upsert above is still atomic for
    // the common case and for concurrent requests using the same subject.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error
    }

    const user = await db.user.findUnique({ where: { email } })
    if (!user) throw error
    return db.user.update({
      where: { id: user.id },
      data: { oidcSub: sub, name: name ?? null },
    })
  }
}

export const authCallbacks = {
  async jwt({ token, account }) {
    if (AUTH_DISABLED) {
      // No-auth mode: reconcile on every JWT callback. A database restore or
      // reset can remove the row while the browser still has a valid cookie.
      const user = await ensureLocalUser()
      token.userId = user.id
      token.accessToken = 'local-no-auth'
      token.error = undefined
      return token
    }

    if (account) {
      token.accessToken = account.access_token
      token.idToken = account.id_token
      token.refreshToken = account.refresh_token
      token.accessTokenExpiresAt =
        account.expires_at ?? Math.floor(Date.now() / 1000) + (account.expires_in ?? 0)
      token.error = undefined
    }

    // Do this for existing JWTs as well as the initial OAuth callback. This
    // repairs a stale token after a database restore without requiring logout.
    if (token.sub && token.email) {
      const user = await ensureOidcUser(token.sub, token.email, token.name)
      token.userId = user.id
    }

    if (
      token.accessToken &&
      token.accessTokenExpiresAt &&
      Date.now() < (Number(token.accessTokenExpiresAt) - ACCESS_TOKEN_REFRESH_BUFFER_SECONDS) * 1000
    ) {
      return token
    }

    if (token.refreshToken) {
      try {
        const refreshed = await refreshAccessToken({ refreshToken: String(token.refreshToken) })
        token.accessToken = refreshed.access_token
        token.accessTokenExpiresAt = Math.floor(Date.now() / 1000) + refreshed.expires_in
        token.refreshToken = refreshed.refresh_token ?? token.refreshToken
        token.idToken = refreshed.id_token ?? token.idToken
        token.error = undefined
      } catch (error) {
        console.error('Failed to refresh Keycloak access token:', error)
        token.error = 'AccessTokenRefreshError'
      }
    } else if (token.accessToken) {
      token.error = 'AccessTokenExpired'
    }

    return token
  },
  async session({ session, token }) {
    return {
      ...session,
      user: {
        ...session.user,
        id: token.userId as string,
      },
      accessToken: token.error ? undefined : token.accessToken as string,
      idToken: token.error ? undefined : token.idToken as string,
      error: token.error as string | undefined,
    }
  },
} satisfies NonNullable<NextAuthConfig['callbacks']>

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: authCallbacks,
})
