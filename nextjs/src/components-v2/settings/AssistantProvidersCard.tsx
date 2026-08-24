"use client"

import { useEffect, useState } from "react"
import { AlertCircle, Bot, Check, Loader2, Plus, Star, Trash2 } from "lucide-react"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components-v2/ui/card"
import { Button } from "@/components-v2/ui/button"
import { Input } from "@/components-v2/ui/input"

interface ProviderModel {
  id: string
}

interface ProviderView {
  route: string
  label: string | null
  apiKeyEnv: string
  api: string | null
  baseUrl: string | null
  models: ProviderModel[]
  defaultModel: string | null
  isDefault: boolean
  credentialConfigured: boolean
  updatedAt: string
}

interface Draft {
  route: string
  label: string
  apiKeyEnv: string
  api: string
  baseUrl: string
  models: string
  defaultModel: string
  apiKey: string
  isDefault: boolean
}

const EMPTY: Draft = {
  route: "", label: "", apiKeyEnv: "", api: "", baseUrl: "",
  models: "", defaultModel: "", apiKey: "", isDefault: false,
}

function defaultApiKeyEnv(route: string): string {
  const cleaned = route.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  return cleaned ? `${cleaned.toUpperCase()}_API_KEY` : ""
}

/**
 * Model providers for the dbt assistant, in the harness's own shape.
 *
 * A provider the harness's adapter ships a catalog for needs nothing but a key;
 * a gateway it does not ship declares its protocol, endpoint and models. That is
 * the same distinction the harness makes, which is what keeps any provider a
 * matter of configuration here rather than a code change.
 */
export default function AssistantProvidersCard() {
  const [providers, setProviders] = useState<ProviderView[] | null>(null)
  const [protocols, setProtocols] = useState<string[]>([])
  const [catalogRoutes, setCatalogRoutes] = useState<string[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    try {
      const response = await fetch("/api/ai-providers")
      if (!response.ok) throw new Error(`Could not read providers (${response.status})`)
      const body = await response.json()
      setProviders(body.providers ?? [])
      setProtocols(body.protocols ?? [])
      setCatalogRoutes(body.catalogRoutes ?? [])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not read providers")
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const isCatalog = draft ? catalogRoutes.includes(draft.route.trim()) : false

  const save = async () => {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch("/api/ai-providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          route: draft.route.trim(),
          label: draft.label.trim() || null,
          apiKeyEnv: draft.apiKeyEnv.trim() || defaultApiKeyEnv(draft.route),
          api: draft.api || null,
          baseUrl: draft.baseUrl.trim() || null,
          models: draft.models
            .split(/[\s,]+/)
            .filter(Boolean)
            .map((id) => ({ id })),
          defaultModel: draft.defaultModel.trim() || null,
          isDefault: draft.isDefault,
          apiKey: draft.apiKey.trim() || null,
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error ?? `Save failed (${response.status})`)
      setProviders(body.providers ?? [])
      setDraft(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Save failed")
    } finally {
      setBusy(false)
    }
  }

  const remove = async (route: string) => {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/ai-providers?route=${encodeURIComponent(route)}`, {
        method: "DELETE",
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error ?? `Remove failed (${response.status})`)
      setProviders(body.providers ?? [])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Remove failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-[#0078D4]" />
          Assistant model providers
        </CardTitle>
        <CardDescription>
          Your own providers for the dbt assistant, in the shape the harness takes:
          a provider it ships a catalog for needs only a key, while any other
          gateway declares its protocol, endpoint and models. Keys are stored
          encrypted and never shown again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {providers === null ? (
          <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading providers…
          </div>
        ) : providers.length === 0 ? (
          <p className="text-sm text-gray-500">
            No provider yet. The assistant falls back to whatever key the deployment
            configured, if any.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {providers.map((provider) => (
              <li key={provider.route} className="flex flex-wrap items-center gap-2 py-2">
                <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
                  {provider.isDefault && <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />}
                  {provider.label || provider.route}
                </span>
                <span className="font-mono text-[11px] text-gray-400">{provider.route}</span>
                {provider.api && (
                  <span className="rounded bg-[#F3F2F1] px-1.5 py-0.5 text-[10px] text-gray-600">
                    {provider.api}
                  </span>
                )}
                {provider.defaultModel && (
                  <span className="text-[11px] text-gray-500">{provider.defaultModel}</span>
                )}
                <span className={`text-[11px] ${provider.credentialConfigured ? "text-green-700" : "text-amber-700"}`}>
                  {provider.credentialConfigured ? `${provider.apiKeyEnv} set` : `${provider.apiKeyEnv} missing`}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setDraft({
                      ...EMPTY,
                      route: provider.route,
                      label: provider.label ?? "",
                      apiKeyEnv: provider.apiKeyEnv,
                      api: provider.api ?? "",
                      baseUrl: provider.baseUrl ?? "",
                      models: provider.models.map((model) => model.id).join(", "),
                      defaultModel: provider.defaultModel ?? "",
                      isDefault: provider.isDefault,
                    })}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    title={`Remove ${provider.route} and its stored key`}
                    onClick={() => void remove(provider.route)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {draft === null ? (
          <Button size="sm" variant="outline" onClick={() => setDraft(EMPTY)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add provider
          </Button>
        ) : (
          <div className="space-y-2 rounded-lg border border-gray-200 bg-[#FAFAFA] p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs text-gray-600">
                Provider id
                <Input
                  className="mt-1"
                  list="assistant-catalog-routes"
                  placeholder="deepseek, openai, anthropic, my-gateway…"
                  value={draft.route}
                  onChange={(event) => setDraft({
                    ...draft,
                    route: event.target.value,
                    apiKeyEnv: draft.apiKeyEnv || defaultApiKeyEnv(event.target.value),
                  })}
                />
                <datalist id="assistant-catalog-routes">
                  {catalogRoutes.map((route) => <option key={route} value={route} />)}
                </datalist>
              </label>
              <label className="text-xs text-gray-600">
                Credential reference
                <Input
                  className="mt-1 font-mono"
                  placeholder={defaultApiKeyEnv(draft.route) || "OPENAI_API_KEY"}
                  value={draft.apiKeyEnv}
                  onChange={(event) => setDraft({ ...draft, apiKeyEnv: event.target.value })}
                />
              </label>
              <label className="text-xs text-gray-600">
                API key {draft.route && <span className="text-gray-400">(write-only)</span>}
                <Input
                  className="mt-1"
                  type="password"
                  // "off" does not stop a password manager; this field is not a
                  // login and must never be autofilled with an unrelated secret.
                  autoComplete="new-password"
                  placeholder="sk-…"
                  value={draft.apiKey}
                  onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                />
              </label>
              <label className="text-xs text-gray-600">
                Display name
                <Input
                  className="mt-1"
                  placeholder="Optional"
                  value={draft.label}
                  onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                />
              </label>
              <label className="text-xs text-gray-600">
                Protocol {isCatalog && <span className="text-gray-400">(optional)</span>}
                <select
                  className="mt-1 h-9 w-full rounded-md border border-gray-200 bg-white px-2 text-xs"
                  value={draft.api}
                  onChange={(event) => setDraft({ ...draft, api: event.target.value })}
                >
                  <option value="">{isCatalog ? "From the installed catalog" : "Select a protocol"}</option>
                  {protocols.map((protocol) => (
                    <option key={protocol} value={protocol}>{protocol}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-gray-600">
                Base URL {isCatalog && <span className="text-gray-400">(optional)</span>}
                <Input
                  className="mt-1"
                  placeholder="https://gateway.example/v1"
                  value={draft.baseUrl}
                  onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                />
              </label>
              <label className="text-xs text-gray-600 sm:col-span-2">
                Models {isCatalog && <span className="text-gray-400">(optional — narrows the catalog)</span>}
                <Input
                  className="mt-1 font-mono"
                  placeholder="gpt-5.1, gpt-5.1-mini"
                  value={draft.models}
                  onChange={(event) => setDraft({ ...draft, models: event.target.value })}
                />
              </label>
              <label className="text-xs text-gray-600">
                Default model
                <Input
                  className="mt-1 font-mono"
                  placeholder="First model listed"
                  value={draft.defaultModel}
                  onChange={(event) => setDraft({ ...draft, defaultModel: event.target.value })}
                />
              </label>
              <label className="flex items-end gap-2 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={draft.isDefault}
                  onChange={(event) => setDraft({ ...draft, isDefault: event.target.checked })}
                />
                Use this provider for new conversations
              </label>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void save()} disabled={busy || !draft.route.trim()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save provider"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDraft(null)} disabled={busy}>
                Cancel
              </Button>
              <span className="text-[11px] text-gray-400">
                {isCatalog
                  ? "The harness ships a catalog for this one: a key is enough."
                  : draft.route.trim() && "Not in the installed catalog: protocol, base URL and models are required."}
              </span>
            </div>
          </div>
        )}

        {error && (
          <p className="flex items-start gap-1.5 text-xs text-red-700">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}
        <p className="flex items-start gap-1.5 text-[11px] text-gray-500">
          <Check className="mt-0.5 h-3 w-3 shrink-0" />
          A conversation already open restarts on its next message so a change here
          takes effect.
        </p>
      </CardContent>
    </Card>
  )
}
