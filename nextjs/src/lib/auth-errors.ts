/**
 * Auth.js reports failures as a code on the query string. Turn each one into a
 * sentence that names the problem and the way out, because the raw code tells
 * the person nothing.
 */
const MESSAGES: Record<string, string> = {
  Configuration:
    'This workspace is not configured for sign-in yet. Check OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET on the server.',
  AccessDenied:
    'Your identity provider refused the sign-in. Ask an administrator whether your account is allowed into this application.',
  Verification:
    'That sign-in link is no longer valid. Start again from this page.',
  OAuthSignin:
    'Could not reach the identity provider. Check that it is up and that OIDC_ISSUER is correct.',
  OAuthCallback:
    'The identity provider rejected the callback. Check that the redirect URI registered there matches this site.',
  OAuthAccountNotLinked:
    'An account with this email already exists from a different provider. Sign in the original way.',
  CredentialsSignin: 'Could not start a local session. Try again.',
  SessionRequired: 'Please sign in to continue.',
}

export function authErrorMessage(code: string | undefined): string {
  // Auth.js redirects to its error page with the literal string "undefined"
  // when it has no code to report.
  if (!code || code === 'undefined') return ''
  return (
    MESSAGES[code] ??
    `Sign-in failed (${code}). Check the server logs for the full reason.`
  )
}
