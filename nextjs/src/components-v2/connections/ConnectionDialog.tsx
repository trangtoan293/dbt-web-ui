"use client"

import React, { useState, useEffect } from "react"
import { Database, HardDrive, Loader2, Plus, Server, Trash2, Zap } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components-v2/ui/dialog"
import { Input } from "@/components-v2/ui/input"
import { createConnection, updateConnection } from "@/lib/api-client"

type ConnectionType = "postgresql" | "duckdb" | "dremio" | "oracle" | "spark"
type SourceTable = "connection" | "dremio_source"

export interface ExistingConnection {
  id: string
  _sourceTable: SourceTable
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
}

interface Props {
  onSaved: () => void
  onClose?: () => void
  existing?: ExistingConnection
  trigger?: React.ReactNode
}

const TYPE_LABELS: Record<ConnectionType, string> = {
  postgresql: "PostgreSQL",
  duckdb: "DuckDB",
  dremio: "Dremio",
  oracle: "Oracle",
  spark: "Apache Spark",
}

const DEFAULT_PORTS: Record<ConnectionType, number> = {
  postgresql: 5432,
  duckdb: 0,
  dremio: 9047,
  oracle: 1521,
  spark: 0,
}

const SELECT_CLS = "flex h-9 w-full rounded-md border border-gray-300 bg-white px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:border-[#0078D4] focus-visible:ring-1 focus-visible:ring-[#0078D4]"

function defaultForm() {
  return {
    name: "",
    host: "localhost",
    port: "5432",
    database: "",
    username: "",
    credential: "",
    sslMode: "prefer",
  }
}

function defaultDremio() {
  return {
    auth_type: "password" as "password" | "pat",
    dremio_space: "@vaultadmin",
    dremio_space_folder: "views",
    object_storage_source: "",
    object_storage_path: "",
    use_ssl: "false",
    twin_strategy: "",
  }
}

function defaultOracle() {
  return {
    schema: "",
  }
}

function defaultSpark() {
  return {
    method: "session",
    threads: "2",
    secret_type: "none" as "none" | "password" | "token",
    driver: "",
    cluster: "",
    endpoint: "",
    auth: "",
    kerberos_service_name: "",
    organization: "",
    connection_string_suffix: "",
    connect_retries: "3",
    connect_timeout: "60",
    use_ssl: "false",
    retry_all: "true",
    query_timeout: "",
    poll_interval: "",
    query_retries: "",
    server_side_parameters: [] as { key: string; value: string }[],
    importText: "",
  }
}

export default function ConnectionDialog({ onSaved, onClose, existing, trigger }: Props) {
  const isEdit = !!existing
  const [open, setOpen] = useState(isEdit)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const initialType: ConnectionType =
    existing?.connectionType === "duckdb" ? "duckdb" :
    existing?.connectionType === "dremio" ? "dremio" :
    existing?.connectionType === "oracle" ? "oracle" :
    existing?.connectionType === "spark" ? "spark" : "postgresql"
  const [type, setType] = useState<ConnectionType>(initialType)
  const [typeSelected, setTypeSelected] = useState(isEdit)
  const [form, setForm] = useState(defaultForm())
  const [dremio, setDremio] = useState(defaultDremio())
  const [oracle, setOracle] = useState(defaultOracle())
  const [spark, setSpark] = useState(defaultSpark())

  useEffect(() => {
    if (!open) return
    if (existing) {
      setTypeSelected(true)
      setType(initialType)
      if (existing._sourceTable === "dremio_source") {
        setForm({
          name: existing.name,
          host: existing.host,
          port: String(existing.port),
          database: existing.catalog ?? "",
          username: existing.username,
          credential: "",
          sslMode: "prefer",
        })
        setDremio({ ...defaultDremio() })
        setOracle({ ...defaultOracle() })
      } else {
        setForm({
          name: existing.name,
          host: existing.host,
          port: String(existing.port),
          database: existing.database ?? "",
          username: existing.username,
          credential: "",
          sslMode: existing.sslMode ?? "prefer",
        })
        if (existing.connectionType === "dremio") {
          const ec = (existing.extraConfig ?? {}) as Record<string, unknown>
          setDremio({
            auth_type: (ec.auth_type as "password" | "pat") ?? "password",
            dremio_space: existing.database ?? "@vaultadmin",
            dremio_space_folder: (ec.dremio_space_folder as string) ?? "views",
            object_storage_source: (ec.object_storage_source as string) ?? "",
            object_storage_path: (ec.object_storage_path as string) ?? "",
            use_ssl: ec.use_ssl === true ? "true" : "false",
            twin_strategy: (ec.twin_strategy as string) ?? "",
          })
        } else if (existing.connectionType === "oracle") {
          const ec = (existing.extraConfig ?? {}) as Record<string, unknown>
          setOracle({ schema: (ec.schema as string) ?? "" })
        } else if (existing.connectionType === "spark") {
          const ec = (existing.extraConfig ?? {}) as Record<string, unknown>
          const params = (ec.server_side_parameters ?? {}) as Record<string, unknown>
          setSpark({
            ...defaultSpark(),
            method: (ec.method as string) ?? "session",
            threads: String(ec.threads ?? "2"),
            secret_type: (ec.secret_type as "none" | "password" | "token") ?? "none",
            driver: (ec.driver as string) ?? "",
            cluster: (ec.cluster as string) ?? "",
            endpoint: (ec.endpoint as string) ?? "",
            auth: (ec.auth as string) ?? "",
            kerberos_service_name: (ec.kerberos_service_name as string) ?? "",
            organization: (ec.organization as string) ?? "",
            connection_string_suffix: (ec.connection_string_suffix as string) ?? "",
            connect_retries: String(ec.connect_retries ?? "3"),
            connect_timeout: String(ec.connect_timeout ?? "60"),
            use_ssl: ec.use_ssl === true ? "true" : "false",
            retry_all: ec.retry_all === false ? "false" : "true",
            query_timeout: String(ec.query_timeout ?? ""),
            poll_interval: String(ec.poll_interval ?? ""),
            query_retries: String(ec.query_retries ?? ""),
            server_side_parameters: Object.entries(params).map(([key, value]) => ({ key, value: String(value ?? "") })),
            importText: "",
          })
        }
      }
    } else {
      setType("postgresql")
      setTypeSelected(false)
      setForm(defaultForm())
      setDremio(defaultDremio())
      setOracle(defaultOracle())
      setSpark(defaultSpark())
    }
    setError("")
  }, [open, existing, initialType])

  function handleTypeChange(next: ConnectionType) {
    setType(next)
    setForm((f) => ({ ...f, port: String(DEFAULT_PORTS[next]) }))
  }

  function chooseType(next: ConnectionType) {
    handleTypeChange(next)
    setTypeSelected(true)
  }

  function setF(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [field]: e.target.value }))
  }

  function setD(field: keyof typeof dremio) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setDremio((d) => ({ ...d, [field]: e.target.value }))
  }

  function setO(field: keyof typeof oracle) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setOracle((o) => ({ ...o, [field]: e.target.value }))
  }

  function setS(field: keyof typeof spark) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setSpark((s) => ({ ...s, [field]: e.target.value }))
  }

  function sparkParamsObject() {
    return Object.fromEntries(
      spark.server_side_parameters
        .filter((row) => row.key.trim())
        .map((row) => [row.key.trim(), row.value])
    )
  }

  function updateSparkParam(index: number, field: "key" | "value", value: string) {
    setSpark((s) => ({
      ...s,
      server_side_parameters: s.server_side_parameters.map((row, i) =>
        i === index ? { ...row, [field]: value } : row
      ),
    }))
  }

  function importSparkParams() {
    try {
      const parsed = JSON.parse(spark.importText) as Record<string, unknown>
      setSpark((s) => ({
        ...s,
        server_side_parameters: Object.entries(parsed).map(([key, value]) => ({ key, value: String(value ?? "") })),
        importText: "",
      }))
    } catch {
      setError("Server-side parameters import expects a JSON object.")
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (!nextOpen && isEdit) onClose?.()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError("")
    try {
      if (existing?._sourceTable === "dremio_source") {
        const payload: Record<string, unknown> = {
          name: form.name,
          host: form.host,
          port: Number(form.port),
          username: form.username,
          database: form.database,
        }
        if (form.credential) payload.tokenEncrypted = form.credential
        await updateConnection(existing.id, "dremio", payload)
      } else if (type === "dremio") {
        const extraConfig: Record<string, unknown> = {
          auth_type: dremio.auth_type,
          dremio_space_folder: dremio.dremio_space_folder,
          use_ssl: dremio.use_ssl === "true",
          object_storage_source: dremio.object_storage_source,
          object_storage_path: dremio.object_storage_path,
        }
        if (dremio.twin_strategy) extraConfig.twin_strategy = dremio.twin_strategy

        const payload: Record<string, unknown> = {
          connectionType: "dremio",
          name: form.name,
          host: form.host,
          port: Number(form.port),
          database: dremio.dremio_space,
          username: form.username,
          extraConfig,
        }
        if (form.credential) payload.passwordEncrypted = form.credential
        if (isEdit && existing) {
          await updateConnection(existing.id, "connection", payload)
        } else {
          await createConnection({ ...payload, passwordEncrypted: form.credential })
        }
      } else if (type === "duckdb") {
        const payload: Record<string, unknown> = {
          connectionType: "duckdb",
          name: form.name,
          host: "",
          port: 0,
          database: form.database,
          username: "",
        }
        if (isEdit && existing) {
          await updateConnection(existing.id, "connection", payload)
        } else {
          await createConnection(payload)
        }
      } else if (type === "oracle") {
        const extraConfig: Record<string, unknown> = {}
        if (oracle.schema) extraConfig.schema = oracle.schema

        const payload: Record<string, unknown> = {
          connectionType: "oracle",
          name: form.name,
          host: form.host,
          port: Number(form.port),
          database: form.database,
          username: form.username,
          extraConfig,
        }
        if (form.credential) payload.passwordEncrypted = form.credential
        if (isEdit && existing) {
          await updateConnection(existing.id, "connection", payload)
        } else {
          await createConnection({ ...payload, passwordEncrypted: form.credential })
        }
      } else if (type === "spark") {
        const extraConfig: Record<string, unknown> = {
          method: spark.method,
          threads: Number(spark.threads || 2),
          secret_type: spark.secret_type,
          connect_timeout: Number(spark.connect_timeout || 60),
          connect_retries: Number(spark.connect_retries || 3),
          retry_all: spark.retry_all === "true",
          use_ssl: spark.use_ssl === "true",
          server_side_parameters: sparkParamsObject(),
        }
        ;([
          "driver", "cluster", "endpoint", "auth", "kerberos_service_name",
          "organization", "connection_string_suffix",
          "query_timeout", "poll_interval", "query_retries",
        ] as const).forEach((key) => {
          const value = spark[key]
          if (value !== "") extraConfig[key] = ["query_timeout", "poll_interval", "query_retries"].includes(key) ? Number(value) : value
        })

        const payload: Record<string, unknown> = {
          connectionType: "spark",
          name: form.name,
          host: form.host,
          port: form.port === "" ? 0 : Number(form.port),
          database: form.database,
          username: form.username,
          extraConfig,
        }
        if (form.credential) payload.passwordEncrypted = form.credential
        if (isEdit && existing) {
          await updateConnection(existing.id, "connection", payload)
        } else {
          await createConnection({ ...payload, passwordEncrypted: form.credential })
        }
      } else {
        const payload: Record<string, unknown> = {
          connectionType: "postgresql",
          name: form.name,
          host: form.host,
          port: Number(form.port),
          database: form.database,
          username: form.username,
          sslMode: form.sslMode,
        }
        if (form.credential) payload.passwordEncrypted = form.credential
        if (isEdit && existing) {
          await updateConnection(existing.id, "connection", payload)
        } else {
          await createConnection({ ...payload, passwordEncrypted: form.credential })
        }
      }
      setOpen(false)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save connection")
    } finally {
      setLoading(false)
    }
  }

  const isDremioSourceEdit = existing?._sourceTable === "dremio_source"
  const title = isEdit ? "Edit Connection" : typeSelected ? `New ${TYPE_LABELS[type]} Connection` : "New Connection"
  const submitLabel = isEdit ? (loading ? "Saving..." : "Save") : (loading ? "Creating..." : "Create")

  return (
    <>
      {trigger ? (
        <span onClick={() => setOpen(true)}>{trigger}</span>
      ) : !isEdit ? (
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> New Connection
        </Button>
      ) : null}

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>

          {!typeSelected ? (
            <div className="space-y-4">
              <div className="grid gap-3">
                <ConnectionTypeOption
                  icon={Server}
                  title="PostgreSQL"
                  description="Warehouse connection using host, database, user, and password."
                  onClick={() => chooseType("postgresql")}
                />
                <ConnectionTypeOption
                  icon={HardDrive}
                  title="DuckDB"
                  description="Local DuckDB file path for lightweight dbt projects."
                  onClick={() => chooseType("duckdb")}
                />
                <ConnectionTypeOption
                  icon={Database}
                  title="Dremio"
                  description="Dremio coordinator connection using password or PAT auth."
                  onClick={() => chooseType("dremio")}
                />
                <ConnectionTypeOption
                  icon={Database}
                  title="Oracle"
                  description="Oracle Database via host, port, service name, and schema."
                  onClick={() => chooseType("oracle")}
                />
                <ConnectionTypeOption
                  icon={Zap}
                  title="Apache Spark"
                  description="dbt-spark connection using session, thrift, http, or ODBC."
                  onClick={() => chooseType("spark")}
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field label="Connection Type">
              <select
                value={type}
                onChange={(e) => handleTypeChange(e.target.value as ConnectionType)}
                className={SELECT_CLS}
                disabled={isEdit}
              >
                {(["postgresql", "duckdb", "dremio", "oracle", "spark"] as ConnectionType[]).map((t) => (
                  <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                ))}
              </select>
            </Field>

            <Field label="Name" required>
              <Input value={form.name} onChange={setF("name")} placeholder={`My ${TYPE_LABELS[type]}`} required />
            </Field>

            {type === "duckdb" && !isDremioSourceEdit && (
              <Field label="File Path" required>
                <Input value={form.database} onChange={setF("database")} placeholder="/data/storage/myproject.duckdb" required />
              </Field>
            )}

            {isDremioSourceEdit && (
              <Field label="Catalog" required>
                <Input value={form.database} onChange={setF("database")} placeholder="catalog" required />
              </Field>
            )}

            {(type === "postgresql" || type === "dremio" || type === "oracle" || type === "spark") && !isDremioSourceEdit && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <Field label="Host" required>
                      <Input value={form.host} onChange={setF("host")} placeholder={type === "dremio" ? "dremio.example.com" : type === "oracle" ? "oracle.example.com" : "localhost"} required />
                    </Field>
                  </div>
                  <Field label="Port" required={type !== "spark" || spark.method !== "session"}>
                    <Input type="number" value={form.port} onChange={setF("port")} required={type !== "spark" || spark.method !== "session"} />
                  </Field>
                </div>

                <Field label="Username" required={type !== "spark" || spark.method === "thrift"}>
                  <Input value={form.username} onChange={setF("username")} placeholder={type === "dremio" ? "vaultadmin" : type === "oracle" ? "system" : type === "spark" ? "optional user" : "postgres"} required={type !== "spark" || spark.method === "thrift"} />
                </Field>
              </>
            )}

            {isDremioSourceEdit && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <Field label="Host" required>
                      <Input value={form.host} onChange={setF("host")} required />
                    </Field>
                  </div>
                  <Field label="Port" required>
                    <Input type="number" value={form.port} onChange={setF("port")} required />
                  </Field>
                </div>
                <Field label="Username" required>
                  <Input value={form.username} onChange={setF("username")} required />
                </Field>
              </>
            )}

            {type === "postgresql" && !isDremioSourceEdit && (
              <>
                <Field label="Database" required>
                  <Input value={form.database} onChange={setF("database")} placeholder="analytics" required />
                </Field>
                <Field label={isEdit ? "Password (leave blank to keep)" : "Password"}>
                  <Input type="password" value={form.credential} onChange={setF("credential")} placeholder={isEdit ? "••••••••" : ""} />
                </Field>
                <Field label="SSL Mode">
                  <select value={form.sslMode} onChange={setF("sslMode")} className={SELECT_CLS}>
                    <option value="disable">Disable</option>
                    <option value="prefer">Prefer</option>
                    <option value="require">Require</option>
                  </select>
                </Field>
              </>
            )}

            {type === "oracle" && !isDremioSourceEdit && (
              <>
                <Field label="Service Name" required>
                  <Input value={form.database} onChange={setF("database")} placeholder="ORCLPDB1" required />
                </Field>
                <Field label={isEdit ? "Password (leave blank to keep)" : "Password"}>
                  <Input type="password" value={form.credential} onChange={setF("credential")} placeholder={isEdit ? "••••••••" : ""} />
                </Field>
                <Field label="Schema">
                  <Input value={oracle.schema} onChange={setO("schema")} placeholder="defaults to username (uppercase)" />
                </Field>
              </>
            )}

            {type === "dremio" && !isDremioSourceEdit && (
              <>
                <Field label="Auth Type" required>
                  <select value={dremio.auth_type} onChange={setD("auth_type")} className={SELECT_CLS}>
                    <option value="password">Password</option>
                    <option value="pat">Personal Access Token (PAT)</option>
                  </select>
                </Field>

                <Field label={isEdit ? `${dremio.auth_type === "pat" ? "PAT" : "Password"} (leave blank to keep)` : (dremio.auth_type === "pat" ? "Personal Access Token" : "Password")}>
                  <Input type="password" value={form.credential} onChange={setF("credential")} placeholder={isEdit ? "••••••••" : (dremio.auth_type === "pat" ? "dremio_pat_..." : "")} />
                </Field>

                <div className="border-t border-gray-100 pt-3">
                  <p className="mb-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Dremio Settings</p>

                  <div className="space-y-3">
                    <Field label="Dremio Space" required>
                      <Input value={dremio.dremio_space} onChange={setD("dremio_space")} placeholder="@vaultadmin" required />
                    </Field>

                    <Field label="Space Folder">
                      <Input value={dremio.dremio_space_folder} onChange={setD("dremio_space_folder")} placeholder="views" />
                    </Field>

                    <Field label="Object Storage Source">
                      <Input value={dremio.object_storage_source} onChange={setD("object_storage_source")} placeholder="LakeHouse" />
                    </Field>

                    <Field label="Object Storage Path">
                      <Input value={dremio.object_storage_path} onChange={setD("object_storage_path")} placeholder="integration_dremio" />
                    </Field>

                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Use SSL">
                        <select value={dremio.use_ssl} onChange={setD("use_ssl")} className={SELECT_CLS}>
                          <option value="false">No</option>
                          <option value="true">Yes</option>
                        </select>
                      </Field>

                      <Field label="Twin Strategy">
                        <Input value={dremio.twin_strategy} onChange={setD("twin_strategy")} placeholder="prevent" />
                      </Field>
                    </div>
                  </div>
                </div>
              </>
            )}

            {type === "spark" && !isDremioSourceEdit && (
              <>
                <Field label="Method" required>
                  <select value={spark.method} onChange={setS("method")} className={SELECT_CLS}>
                    <option value="session">Session</option>
                    <option value="thrift">Thrift</option>
                    <option value="http">HTTP</option>
                    <option value="odbc">ODBC</option>
                  </select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Schema" required>
                    <Input value={form.database} onChange={setF("database")} placeholder="{{ env_var('SCHEMA_NAME', 'integration') }}" required />
                  </Field>
                  <Field label="Threads">
                    <Input type="number" value={spark.threads} onChange={setS("threads")} />
                  </Field>
                </div>

                <div className="border-t border-gray-100 pt-3">
                  <p className="mb-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Auth</p>
                  <Field label="Secret Type">
                    <select value={spark.secret_type} onChange={setS("secret_type")} className={SELECT_CLS}>
                      <option value="none">None</option>
                      <option value="password">Password</option>
                      <option value="token">Token</option>
                    </select>
                  </Field>
                  {spark.secret_type !== "none" && (
                    <Field label={isEdit ? `${spark.secret_type === "token" ? "Token" : "Password"} (leave blank to keep)` : (spark.secret_type === "token" ? "Token" : "Password")}>
                      <Input type="password" value={form.credential} onChange={setF("credential")} placeholder={isEdit ? "••••••••" : ""} />
                    </Field>
                  )}
                </div>

                <div className="border-t border-gray-100 pt-3">
                  <p className="mb-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Connection Options</p>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Connect Timeout"><Input type="number" value={spark.connect_timeout} onChange={setS("connect_timeout")} /></Field>
                    <Field label="Connect Retries"><Input type="number" value={spark.connect_retries} onChange={setS("connect_retries")} /></Field>
                    <Field label="Retry All"><select value={spark.retry_all} onChange={setS("retry_all")} className={SELECT_CLS}><option value="true">Yes</option><option value="false">No</option></select></Field>
                    <Field label="Use SSL"><select value={spark.use_ssl} onChange={setS("use_ssl")} className={SELECT_CLS}><option value="false">No</option><option value="true">Yes</option></select></Field>
                    <Field label="Query Timeout"><Input type="number" value={spark.query_timeout} onChange={setS("query_timeout")} /></Field>
                    <Field label="Poll Interval"><Input type="number" value={spark.poll_interval} onChange={setS("poll_interval")} /></Field>
                    <Field label="Query Retries"><Input type="number" value={spark.query_retries} onChange={setS("query_retries")} /></Field>
                  </div>
                </div>

                <div className="border-t border-gray-100 pt-3">
                  <p className="mb-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Advanced Method Fields</p>
                  {spark.method === "odbc" && (
                    <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                      ODBC requires a system ODBC driver and dbt-spark ODBC extras in the runner image.
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Driver"><Input value={spark.driver} onChange={setS("driver")} /></Field>
                    <Field label="Cluster"><Input value={spark.cluster} onChange={setS("cluster")} /></Field>
                    <Field label="Endpoint"><Input value={spark.endpoint} onChange={setS("endpoint")} /></Field>
                    <Field label="Auth"><Input value={spark.auth} onChange={setS("auth")} /></Field>
                    <Field label="Kerberos Service"><Input value={spark.kerberos_service_name} onChange={setS("kerberos_service_name")} /></Field>
                    <Field label="Organization"><Input value={spark.organization} onChange={setS("organization")} /></Field>
                  </div>
                  <Field label="Connection String Suffix">
                    <Input value={spark.connection_string_suffix} onChange={setS("connection_string_suffix")} />
                  </Field>
                </div>

                <div className="border-t border-gray-100 pt-3">
                  <p className="mb-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Server-side Parameters</p>
                  <div className="space-y-2">
                    {spark.server_side_parameters.map((row, index) => (
                      <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                        <Input value={row.key} onChange={(e) => updateSparkParam(index, "key", e.target.value)} placeholder="spark.remote" />
                        <Input value={row.value} onChange={(e) => updateSparkParam(index, "value", e.target.value)} placeholder="sc://host:15002" />
                        <Button type="button" variant="outline" onClick={() => setSpark((s) => ({ ...s, server_side_parameters: s.server_side_parameters.filter((_, i) => i !== index) }))}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                    <Button type="button" variant="outline" onClick={() => setSpark((s) => ({ ...s, server_side_parameters: [...s.server_side_parameters, { key: "", value: "" }] }))}>
                      <Plus className="h-4 w-4" /> Add Parameter
                    </Button>
                    <textarea value={spark.importText} onChange={setS("importText")} className={`${SELECT_CLS} min-h-20 py-2`} placeholder='{"spark.remote":"sc://host:15002"}' />
                    <Button type="button" variant="outline" onClick={importSparkParams}>Import JSON</Button>
                  </div>
                </div>
              </>
            )}

            {isDremioSourceEdit && (
              <Field label={isEdit ? "Token (leave blank to keep)" : "Token"}>
                <Input type="password" value={form.credential} onChange={setF("credential")} placeholder={isEdit ? "••••••••" : "dremio_pat_..."} />
              </Field>
            )}

            {error && <p className="text-sm text-red-600">{error}</p>}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>Cancel</Button>
              {!isEdit && (
                <Button type="button" variant="outline" onClick={() => setTypeSelected(false)}>
                  Back
                </Button>
              )}
              <Button type="submit" disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {submitLabel}
              </Button>
            </DialogFooter>
          </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function ConnectionTypeOption({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-md border border-gray-200 bg-white p-4 text-left transition-colors hover:border-[#0078D4] hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4]"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-700">
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-gray-900">{title}</span>
        <span className="mt-1 block text-sm text-gray-500">{description}</span>
      </span>
    </button>
  )
}

function Field({ label, required = false, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">
        {label}{required && <span className="text-red-500"> *</span>}
      </label>
      {children}
    </div>
  )
}
