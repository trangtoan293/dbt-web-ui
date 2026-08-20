"use client"

import React, { useState, useEffect, useCallback } from "react"
import { getConnections, deleteConnection, testConnectionById } from "@/lib/api-client"
import { Card, CardContent } from "@/components-v2/ui/card"
import { Button } from "@/components-v2/ui/button"
import { Server, Trash2, Pencil, PlugZap, Loader2 } from "lucide-react"
import EmptyState from "@/components-v2/shared/EmptyState"
import ConnectionDialog, { ExistingConnection } from "@/components-v2/connections/ConnectionDialog"

interface Connection {
  id: string
  name: string
  connectionType: string
  host: string
  port: number
  database: string
  username: string
  passwordEncrypted?: string | null
  sslMode?: string | null
  extraConfig?: Record<string, unknown> | null
  catalog?: string | null
  _sourceTable: "connection" | "dremio_source"
}

const TYPE_LABELS: Record<string, string> = {
  postgresql: "PostgreSQL",
  duckdb: "DuckDB",
  dremio: "Dremio",
  oracle: "Oracle",
  spark: "Apache Spark",
}

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [editing, setEditing] = useState<Connection | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await getConnections()
      setConnections(Array.isArray(data) ? data : [])
    } catch (e) {
      console.error("Failed to load connections", e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleDelete(c: Connection) {
    if (!confirm(`Delete "${c.name}"?`)) return
    setDeleting(c.id)
    try {
      const type = c._sourceTable === "dremio_source" ? "dremio" : "connection"
      await deleteConnection(c.id, type)
      setConnections((prev) => prev.filter((x) => x.id !== c.id))
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed")
    } finally {
      setDeleting(null)
    }
  }

  async function handleTest(c: Connection) {
    setTesting(c.id)
    try {
      const type = c._sourceTable === "dremio_source" ? "dremio" : "connection"
      const result = await testConnectionById(c.id, type)
      alert(result.success ? `Connection "${c.name}" OK` : `Connection "${c.name}" failed: ${result.message}`)
    } catch (e) {
      alert(e instanceof Error ? e.message : "Test failed")
    } finally {
      setTesting(null)
    }
  }

  function handleEdit(c: Connection) {
    setEditing(c)
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Connections</h1>
          <p className="text-sm text-gray-500 mt-1">Manage your database connections</p>
        </div>
        <ConnectionDialog onSaved={load} />
      </div>

      {loading ? (
        <div className="grid gap-4">
          {[1, 2].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6"><div className="h-4 bg-gray-200 rounded w-1/3" /></CardContent>
            </Card>
          ))}
        </div>
      ) : connections.length === 0 ? (
        <EmptyState
          icon={PlugZap}
          title="No connections configured"
          description="Add a database connection to start running dbt models."
          action={<ConnectionDialog onSaved={load} />}
        />
      ) : (
        <div className="grid gap-4">
          {connections.map((c) => (
            <Card key={c.id}>
              <CardContent className="flex items-center gap-4 p-4">
                <div className="h-10 w-10 rounded bg-gray-100 flex items-center justify-center">
                  <Server className="h-5 w-5 text-gray-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900">{c.name}</p>
                  <p className="text-sm text-gray-500">
                    {TYPE_LABELS[c.connectionType] ?? c.connectionType}
                    {c.host ? ` — ${c.host}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleTest(c)}
                    disabled={testing === c.id}
                    title="Test connection"
                  >
                    {testing === c.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <PlugZap className="h-4 w-4" />
                    )}
                    <span className="ml-1 hidden sm:inline">Test</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleEdit(c)}
                    title="Edit connection"
                  >
                    <Pencil className="h-4 w-4" />
                    <span className="ml-1 hidden sm:inline">Edit</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDelete(c)}
                    disabled={deleting === c.id}
                    className="text-red-600 hover:text-red-700 hover:border-red-300"
                    title="Delete connection"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <ConnectionDialog
          existing={editing as ExistingConnection}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </div>
  )
}
