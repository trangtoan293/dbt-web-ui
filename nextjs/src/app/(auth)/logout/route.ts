import { NextResponse } from 'next/server'
import { auth, signOut } from '@/lib/auth'
import { AUTH_DISABLED } from '@/lib/auth-constants'
import { discoverOidc } from '@/lib/oidc'
import { publicOrigin } from '@/lib/origin'

/**
 * Sign out locally, then hand off to the IdP's RP-initiated logout so the
 * provider session ends too — otherwise the next sign-in silently re-uses it.
 *
 * The end-session URL comes from OIDC discovery. When the provider advertises
 * none (or discovery fails) the local sign-out still stands and we fall back to
 * the login page.
 */
export async function GET(request: Request) {
  // `signedOut` stops the login page from signing a single-user install straight
  // back in, which would make this endpoint a no-op.
  const loginUrl = `${publicOrigin(request)}/login?signedOut=1`

  if (AUTH_DISABLED) {
    await signOut({ redirect: false })
    return NextResponse.redirect(loginUrl)
  }

  const session = await auth()
  const idToken = session?.idToken

  let redirectTo = loginUrl
  try {
    const { end_session_endpoint } = await discoverOidc()
    if (end_session_endpoint) {
      const endSession = new URL(end_session_endpoint)
      endSession.searchParams.set('post_logout_redirect_uri', loginUrl)
      if (idToken) {
        endSession.searchParams.set('id_token_hint', idToken)
      } else if (process.env.OIDC_CLIENT_ID) {
        endSession.searchParams.set('client_id', process.env.OIDC_CLIENT_ID)
      }
      redirectTo = endSession.toString()
    }
  } catch (error) {
    console.error('OIDC discovery failed during logout:', error)
  }

  await signOut({ redirect: false })
  return NextResponse.redirect(redirectTo)
}
