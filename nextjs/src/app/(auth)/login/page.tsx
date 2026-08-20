import { AUTH_DISABLED } from "@/lib/auth-constants"
import { authErrorMessage } from "@/lib/auth-errors"
import AuthShell from "./AuthShell"
import AutoLogin from "./AutoLogin"
import SsoLogin from "./SsoLogin"

// The auth mode is a runtime setting. Without this the page is prerendered at
// build time, AUTH_DISABLED is baked in as false, and a single-user install is
// stuck staring at an SSO button that goes nowhere.
export const dynamic = "force-dynamic"

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; signedOut?: string }>
}) {
  const { error, signedOut } = await searchParams
  const message = authErrorMessage(error)

  // Admins name their own provider ("Keycloak", "Okta", "Google") so the button
  // says where the user is actually going instead of an acronym.
  const providerName = process.env.OIDC_PROVIDER_NAME || "single sign-on"

  return (
    <AuthShell>
      {AUTH_DISABLED ? (
        <AutoLogin initialError={message} signedOut={signedOut === "1"} />
      ) : (
        <SsoLogin
          providerName={providerName}
          initialError={message}
          signedOut={signedOut === "1"}
        />
      )}
    </AuthShell>
  )
}
