import NextAuth from 'next-auth'
import { authConfig } from '@/lib/auth.config'
import { AUTH_DISABLED, LOCAL_USER } from '@/lib/auth-constants'
import { refreshAccessToken } from '@/lib/auth-refresh'
import { db } from '@/lib/db'

const ACCESS_TOKEN_REFRESH_BUFFER_SECONDS = 60

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    async jwt({ token, account }) {
      if (AUTH_DISABLED) {
        // No-auth mode: ensure the fixed local user exists, attach a dummy
        // access token so downstream API calls don't bounce to sign-in.
        if (!token.userId) {
          let user = await db.user.findUnique({ where: { oidcSub: LOCAL_USER.sub } })
          if (!user) {
            user = await db.user.create({
              data: { oidcSub: LOCAL_USER.sub, email: LOCAL_USER.email, name: LOCAL_USER.name },
            })
          }
          token.userId = user.id
        }
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
        if (token.sub && token.email) {
          let user = await db.user.findUnique({ where: { oidcSub: token.sub } })
          if (!user) {
            user = await db.user.findUnique({ where: { email: token.email } })
          }
          if (user) {
            user = await db.user.update({
              where: { id: user.id },
              data: { oidcSub: token.sub, name: token.name ?? null },
            })
          } else {
            user = await db.user.create({
              data: {
                oidcSub: token.sub,
                email: token.email,
                name: token.name ?? null,
              },
            })
          }
          token.userId = user.id
        }
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
  },
})
