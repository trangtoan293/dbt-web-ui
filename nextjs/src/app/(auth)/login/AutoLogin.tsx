"use client"

import { useCallback, useEffect, useState } from "react"
import { signIn } from "next-auth/react"
import { TriangleAlert } from "lucide-react"

// No-auth mode: sign the single local user in and go straight to the workspace.
export default function AutoLogin({
  initialError = "",
  signedOut = false,
}: {
  initialError?: string
  signedOut?: boolean
}) {
  const [error, setError] = useState(initialError)

  const enter = useCallback(async () => {
    setError("")
    try {
      await signIn("credentials", { redirectTo: "/" })
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not start a local session. Try again.",
      )
    }
  }, [])

  useEffect(() => {
    // Do not sign back in on arrival after an explicit sign-out, and do not
    // retry a failed attempt on its own — either turns this into a loop.
    if (initialError || signedOut) return
    void enter()
  }, [enter, initialError, signedOut])

  return (
    <>
      <h1 className="text-[1.375rem] font-semibold leading-tight tracking-[-0.02em] text-slate-900">
        {error
          ? "Could not open your workspace"
          : signedOut
            ? "You're signed out"
            : "Opening your workspace"}
      </h1>
      <p className="mt-2 text-sm leading-6 text-slate-500">
        {error
          ? error
          : signedOut
            ? "This instance runs in single-user mode, so there is no account to switch to."
            : "Single-user mode is on, so there is nothing to sign in to."}
      </p>

      {error || signedOut ? (
        <button
          type="button"
          onClick={() => void enter()}
          className="mt-6 flex h-11 w-full items-center justify-center rounded-lg bg-[#0078D4] text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#106EBE] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4] focus-visible:ring-offset-2"
        >
          {error ? "Try again" : "Open workspace"}
        </button>
      ) : (
        <div
          role="status"
          aria-label="Opening your workspace"
          className="mt-6 h-1 w-full overflow-hidden rounded-full bg-slate-100"
        >
          <div className="auth-sweep h-full w-1/3 rounded-full bg-[#0078D4]" />
        </div>
      )}

      <p className="mt-6 flex items-start gap-2 rounded-lg bg-amber-50 px-3.5 py-3 text-xs leading-5 text-amber-800">
        <TriangleAlert className="mt-px h-4 w-4 shrink-0 text-amber-600" />
        <span>
          Authentication is disabled on this instance. Keep it on localhost or a
          trusted network — anyone who can reach it is this user.
        </span>
      </p>
    </>
  )
}
