"use client"

import React, { useCallback, useEffect, useState } from "react"
import { AlertCircle, Loader2, Trash2, UserPlus } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Input } from "@/components-v2/ui/input"

interface Grant {
  userId: string
  email: string
  name: string | null
  role: "admin" | "contributor" | "viewer"
  level: "view" | "edit"
  grantedBy: string
  updatedAt: string
}

interface AccessResponse {
  canManage: boolean
  grants: Grant[]
}

interface Props {
  projectId: string
}

/**
 * Who may view or edit this one project. Role (Settings → Users) sets the
 * ceiling of what someone could ever do; a row here is what actually lets
 * them reach *this* project. See docs/rbac-design.md.
 */
export default function AccessPanel({ projectId }: Props): React.ReactElement {
  const [state, setState] = useState<AccessResponse | null>(null)
  const [email, setEmail] = useState("")
  const [level, setLevel] = useState<Grant["level"]>("edit")
  const [adding, setAdding] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    fetch(`/api/projects/${projectId}/access`)
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body?.error ?? `Could not load access (${response.status})`)
        setState(body)
      })
      .catch((loadError: unknown) =>
        setError(loadError instanceof Error ? loadError.message : "Could not load access"),
      )
  }, [projectId])

  useEffect(load, [load])

  async function addGrant() {
    const trimmed = email.trim()
    if (!trimmed) return
    setAdding(true)
    setError(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, level }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error ?? `Could not grant access (${response.status})`)
      setEmail("")
      load()
    } catch (addError: unknown) {
      setError(addError instanceof Error ? addError.message : "Could not grant access")
    } finally {
      setAdding(false)
    }
  }

  async function removeGrant(userId: string) {
    setRemovingId(userId)
    setError(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/access/${userId}`, { method: "DELETE" })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body?.error ?? `Could not remove access (${response.status})`)
      load()
    } catch (removeError: unknown) {
      setError(removeError instanceof Error ? removeError.message : "Could not remove access")
    } finally {
      setRemovingId(null)
    }
  }

  if (state === null) {
    return (
      <div className="flex items-center gap-2 py-5 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading access…
      </div>
    )
  }

  const { canManage, grants } = state

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        {canManage
          ? "Admin sees every project regardless of what's listed here. Add someone by the email they sign in with - they need to have signed in at least once."
          : "Who has access to this project. Only someone with edit here can change it."}
      </p>

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Level</th>
              <th className="px-3 py-2 font-medium">Granted by</th>
              {canManage && <th className="px-3 py-2 font-medium" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {grants.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 4 : 3} className="px-3 py-6 text-center text-gray-500">
                  Nobody has been granted access yet.
                </td>
              </tr>
            ) : (
              grants.map((grant) => (
                <tr key={grant.userId}>
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-gray-900">{grant.name || grant.email}</div>
                    {grant.name && <div className="text-xs text-gray-500">{grant.email}</div>}
                    {grant.role === "viewer" && grant.level === "edit" && (
                      <div className="text-[11px] text-amber-700" title="Their account role caps them to view, whatever this grant says">
                        capped to view by role
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-gray-700">{grant.level}</td>
                  <td className="px-3 py-2.5 text-gray-500">{grant.grantedBy}</td>
                  {canManage && (
                    <td className="px-3 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => void removeGrant(grant.userId)}
                        disabled={removingId === grant.userId}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
                        title={`Remove ${grant.email}'s access`}
                        aria-label={`Remove ${grant.email}'s access`}
                      >
                        {removingId === grant.userId ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </button>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {canManage && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <label className="min-w-[200px] flex-1 text-xs font-medium text-gray-700">
            Email
            <Input
              className="mt-1"
              type="email"
              placeholder="teammate@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addGrant()
              }}
            />
          </label>
          <label className="text-xs font-medium text-gray-700">
            Level
            <select
              className="mt-1 flex h-9 rounded-md border border-gray-300 bg-white px-2.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-[#0078D4]"
              value={level}
              onChange={(event) => setLevel(event.target.value as Grant["level"])}
            >
              <option value="edit">Edit</option>
              <option value="view">View</option>
            </select>
          </label>
          <Button type="button" onClick={() => void addGrant()} disabled={adding || !email.trim()}>
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            Grant access
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}
    </div>
  )
}
