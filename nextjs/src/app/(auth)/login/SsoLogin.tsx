"use client"

import { useState } from "react"
import { signIn } from "next-auth/react"
import { ArrowRight, Loader2, ShieldCheck } from "lucide-react"
import { PRODUCT_NAME } from "@/lib/branding"

export default function SsoLogin({
  providerName,
  initialError = "",
  signedOut = false,
}: {
  providerName: string
  initialError?: string
  signedOut?: boolean
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(initialError)

  const handleLogin = async () => {
    setLoading(true)
    setError("")
    try {
      await signIn("oidc", { redirectTo: "/" })
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `Could not reach ${providerName}. Check that the provider is up and try again.`,
      )
      setLoading(false)
    }
  }

  return (
    <>
      <h1 className="text-[1.375rem] font-semibold leading-tight tracking-[-0.02em] text-slate-900">
        Sign in to {PRODUCT_NAME}
      </h1>
      <p className="mt-2 text-sm leading-6 text-slate-500">
        {signedOut
          ? "You're signed out. Sign in again to pick up where you left off."
          : `You'll continue to ${providerName} to authenticate, then land back in your workspace.`}
      </p>

      {error && (
        <p
          role="alert"
          className="mt-5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm leading-6 text-red-700"
        >
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleLogin}
        disabled={loading}
        className="group mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#0078D4] text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#106EBE] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70"
      >
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Redirecting to {providerName}…
          </>
        ) : (
          <>
            Continue with {providerName}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </>
        )}
      </button>

      <p className="mt-6 flex items-start gap-2 border-t border-slate-100 pt-5 text-xs leading-5 text-slate-500">
        <ShieldCheck className="mt-px h-4 w-4 shrink-0 text-slate-400" />
        <span>
          Accounts live in your identity provider. This workspace never sees your
          password.
        </span>
      </p>
    </>
  )
}
