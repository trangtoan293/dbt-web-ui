"use client"

import { useEffect, useState } from "react"
import { AlertCircle, Loader2, ShieldCheck, Users } from "lucide-react"
import { useGlobal } from "@/lib/context/GlobalContext"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components-v2/ui/card"

interface AdminUser {
  id: string
  email: string
  name: string | null
  role: "admin" | "contributor" | "viewer"
  createdAt: string
}

const ROLES: AdminUser["role"][] = ["admin", "contributor", "viewer"]

const ROLE_HELP: Record<AdminUser["role"], string> = {
  admin: "Sees and edits every project, no grant needed.",
  contributor: "Edits only projects granted to them - view or edit, set per project.",
  viewer: "Read-only on projects granted to them, whatever level the grant says.",
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

/**
 * Role is the ceiling ("contributor" can still be view-only on a given
 * project); which projects a role actually reaches is set per project, on
 * that project's own Access tab (Project settings → Access), not here.
 * See docs/rbac-design.md.
 */
export default function AdminUsersCard() {
  const { user: currentUser } = useGlobal()
  // null = still checking; false = not an admin, render nothing; array = loaded.
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [visible, setVisible] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch("/api/admin/users")
      .then(async (response) => {
        if (response.status === 403) {
          if (!cancelled) setVisible(false)
          return
        }
        const body = await response.json()
        if (!response.ok) throw new Error(body?.error ?? `Could not load users (${response.status})`)
        if (!cancelled) setUsers(body.users ?? [])
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Could not load users")
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!visible) return null

  async function changeRole(id: string, role: AdminUser["role"]) {
    setSavingId(id)
    setError(null)
    try {
      const response = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error ?? `Could not change role (${response.status})`)
      setUsers((current) =>
        (current ?? []).map((u) => (u.id === id ? { ...u, role: body.user.role } : u)),
      )
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : "Could not change role")
    } finally {
      setSavingId(null)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5 text-[#0078D4]" /> Users
        </CardTitle>
        <CardDescription className="max-w-2xl leading-5">
          Everyone who has signed in at least once. Creating or removing the account itself
          happens in your identity provider - this only sets what they may do here. Which
          projects a contributor or viewer actually reaches is granted per project, on that
          project&apos;s own Access tab.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {users === null ? (
          <div className="flex items-center gap-2 py-5 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading users…
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2 font-medium">User</th>
                  <th className="px-3 py-2 font-medium">Member since</th>
                  <th className="px-3 py-2 font-medium">Role</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-gray-900">{u.name || u.email}</div>
                      {u.name && <div className="text-xs text-gray-500">{u.email}</div>}
                      {u.id === currentUser?.id && (
                        <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-[#0078D4]">
                          <ShieldCheck className="h-3 w-3" /> This is you
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-gray-600">{formatDate(u.createdAt)}</td>
                    <td className="px-3 py-2.5">
                      <select
                        className="h-9 rounded-lg border border-slate-300 bg-white px-2.5 text-sm shadow-sm focus:border-[#0078D4] focus:outline-none focus:ring-2 focus:ring-[#0078D4]/15 disabled:opacity-60"
                        value={u.role}
                        disabled={savingId === u.id}
                        title={ROLE_HELP[u.role]}
                        onChange={(event) => void changeRole(u.id, event.target.value as AdminUser["role"])}
                      >
                        {ROLES.map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {error && (
          <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
