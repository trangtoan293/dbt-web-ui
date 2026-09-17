"use client"

import { useEffect, useState, type ReactNode } from "react"
import {
  AlertCircle, Bot, Check, CheckCircle2, KeyRound, Loader2, Pencil,
  PlugZap, Plus, Server, Star, Trash2, TriangleAlert,
} from "lucide-react"

import { Button } from "@/components-v2/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components-v2/ui/card"
import { Input } from "@/components-v2/ui/input"
import {
  createProviderDraft, draftToProviderInput, validateProviderDraft,
  type ProviderDraft, type ProviderViewModel,
} from "@/lib/ai-provider-form"

interface ProviderPresetView {
  route: string
  label: string
  description: string
  apiKeyPlaceholder: string
  baseUrl: string
}

interface ConnectionResult {
  status: "connected" | "warning" | "error"
  message: string
  latencyMs?: number
}

const PROTOCOL_LABELS: Record<string, string> = {
  "openai-completions": "Chat Completions — works with most compatible APIs",
  "openai-responses": "OpenAI Responses API",
  "anthropic-messages": "Anthropic Messages API",
}

function ResultMessage({ result }: { result: ConnectionResult }) {
  const isConnected = result.status === "connected"
  const isWarning = result.status === "warning"
  const Icon = isConnected ? CheckCircle2 : isWarning ? TriangleAlert : AlertCircle
  const tone = isConnected
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : isWarning
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : "border-red-200 bg-red-50 text-red-800"

  return (
    <div role="status" className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${tone}`}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        {result.message}
        {typeof result.latencyMs === "number" && result.status !== "error" && (
          <span className="ml-1 opacity-70">({result.latencyMs} ms)</span>
        )}
      </span>
    </div>
  )
}

function FieldHelp({ children }: { children: ReactNode }) {
  return <span className="mt-1 block text-[11px] leading-4 text-gray-500">{children}</span>
}

export default function AssistantProvidersCard() {
  const [providers, setProviders] = useState<ProviderViewModel[] | null>(null)
  const [protocols, setProtocols] = useState<string[]>([])
  const [presets, setPresets] = useState<ProviderPresetView[]>([])
  const [draft, setDraft] = useState<ProviderDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [removingRoute, setRemovingRoute] = useState<string | null>(null)
  const [testingTarget, setTestingTarget] = useState<string | null>(null)
  const [draftResult, setDraftResult] = useState<ConnectionResult | null>(null)
  const [savedResults, setSavedResults] = useState<Record<string, ConnectionResult>>({})
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    try {
      const response = await fetch("/api/ai-providers")
      if (!response.ok) throw new Error(`Could not read AI connections (${response.status})`)
      const body = await response.json()
      setProviders(body.providers ?? [])
      setProtocols(body.protocols ?? [])
      setPresets(body.providerPresets ?? [])
      setError(null)
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : "Could not read AI connections")
    }
  }

  useEffect(() => { void load() }, [])

  function updateDraft<K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : null)
    setDraftResult(null)
    setError(null)
  }

  function selectConnectionType(connectionType: string) {
    const next = createProviderDraft(connectionType)
    next.isDefault = draft?.isDefault ?? false
    setDraft(next)
    setDraftResult(null)
    setError(null)
  }

  async function checkConnection(inputDraft: ProviderDraft, target: string) {
    const problem = validateProviderDraft(inputDraft)
    if (problem) {
      setError(problem)
      return
    }
    setTestingTarget(target)
    setError(null)
    if (target === "draft") setDraftResult(null)
    try {
      const response = await fetch("/api/ai-providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftToProviderInput(inputDraft)),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error ?? `Connection check failed (${response.status})`)
      if (target === "draft") setDraftResult(body)
      else setSavedResults((current) => ({ ...current, [target]: body }))
    } catch (checkError: unknown) {
      const message = checkError instanceof Error ? checkError.message : "Connection check failed"
      if (target === "draft") setDraftResult({ status: "error", message })
      else setSavedResults((current) => ({ ...current, [target]: { status: "error", message } }))
    } finally {
      setTestingTarget(null)
    }
  }

  async function save() {
    if (!draft) return
    const problem = validateProviderDraft(draft)
    if (problem) {
      setError(problem)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const response = await fetch("/api/ai-providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftToProviderInput(draft)),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error ?? `Save failed (${response.status})`)
      setProviders(body.providers ?? [])
      setDraft(null)
      setDraftResult(null)
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  async function remove(route: string) {
    setRemovingRoute(route)
    setError(null)
    try {
      const response = await fetch(`/api/ai-providers?route=${encodeURIComponent(route)}`, { method: "DELETE" })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error ?? `Remove failed (${response.status})`)
      setProviders(body.providers ?? [])
      setSavedResults((current) => {
        const next = { ...current }
        delete next[route]
        return next
      })
    } catch (removeError: unknown) {
      setError(removeError instanceof Error ? removeError.message : "Remove failed")
    } finally {
      setRemovingRoute(null)
    }
  }

  const selectedPreset = draft ? presets.find((preset) => preset.route === draft.connectionType) : undefined
  const isCustom = draft?.connectionType === "custom"
  const actionBusy = saving || removingRoute !== null || testingTarget !== null

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-[#0078D4]" /> AI connections
        </CardTitle>
        <CardDescription className="max-w-2xl leading-5">
          Connect the provider and model used by the dbt assistant. API keys are encrypted,
          write-only, and never shown again.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="grid gap-2 rounded-xl border border-blue-100 bg-blue-50/60 p-3 sm:grid-cols-3">
          {[
            ["1", "Choose", "Select a provider or compatible API"],
            ["2", "Check", "Verify endpoint, key, and model"],
            ["3", "Save", "Use it for new conversations"],
          ].map(([number, title, description]) => (
            <div key={number} className="flex gap-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#0078D4] text-xs font-semibold text-white">{number}</span>
              <span>
                <span className="block text-xs font-semibold text-gray-900">{title}</span>
                <span className="block text-[11px] leading-4 text-gray-600">{description}</span>
              </span>
            </div>
          ))}
        </div>

        {providers === null ? (
          <div className="flex items-center gap-2 py-5 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading AI connections…
          </div>
        ) : providers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 px-4 py-5 text-center">
            <Server className="mx-auto mb-2 h-5 w-5 text-gray-400" />
            <p className="text-sm font-medium text-gray-800">No personal AI connection</p>
            <p className="mt-1 text-xs text-gray-500">The assistant uses the deployment default, if one is configured.</p>
          </div>
        ) : (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-gray-500">Saved connections</h3>
            {providers.map((provider) => {
              const preset = presets.find((item) => item.route === provider.route)
              const providerDraft = createProviderDraft(preset?.route ?? "custom", provider)
              const result = savedResults[provider.route]
              return (
                <div key={provider.route} className="rounded-lg border border-gray-200 p-3">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-gray-900">{provider.label || preset?.label || provider.route}</span>
                        {provider.isDefault && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                            <Star className="h-3 w-3 fill-amber-400 text-amber-400" /> Default
                          </span>
                        )}
                        <span className={`inline-flex items-center gap-1 text-[11px] ${provider.credentialConfigured ? "text-emerald-700" : "text-amber-700"}`}>
                          <KeyRound className="h-3 w-3" /> {provider.credentialConfigured ? "API key saved" : "API key missing"}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500">
                        <span>{preset?.label ?? "Custom OpenAI-compatible"}</span>
                        {provider.baseUrl && <span className="truncate font-mono">{provider.baseUrl}</span>}
                        {provider.defaultModel && <span>Model: <span className="font-mono">{provider.defaultModel}</span></span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" variant="outline" disabled={actionBusy || !provider.credentialConfigured} onClick={() => void checkConnection(providerDraft, provider.route)}>
                        {testingTarget === provider.route ? <Loader2 className="animate-spin" /> : <PlugZap />} Check
                      </Button>
                      <Button size="sm" variant="outline" disabled={actionBusy} onClick={() => { setDraft(providerDraft); setDraftResult(null); setError(null) }} aria-label={`Edit ${provider.label || provider.route}`}>
                        <Pencil />
                      </Button>
                      <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50 hover:text-red-700" disabled={actionBusy} title={`Remove ${provider.label || provider.route} and its stored API key`} onClick={() => void remove(provider.route)} aria-label={`Remove ${provider.label || provider.route}`}>
                        {removingRoute === provider.route ? <Loader2 className="animate-spin" /> : <Trash2 />}
                      </Button>
                    </div>
                  </div>
                  {result && <div className="mt-2"><ResultMessage result={result} /></div>}
                </div>
              )
            })}
          </div>
        )}

        {draft === null ? (
          <Button variant="outline" onClick={() => setDraft(createProviderDraft("openai"))}>
            <Plus /> Add AI connection
          </Button>
        ) : (
          <div className="space-y-5 rounded-xl border border-blue-200 bg-slate-50/60 p-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">{draft.editingRoute ? "Edit AI connection" : "Add AI connection"}</h3>
              <p className="mt-0.5 text-xs text-gray-500">Required fields are marked with <span className="text-red-600">*</span>.</p>
            </div>

            <fieldset className="space-y-3">
              <legend className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-gray-500">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-200 text-[10px] text-gray-700">1</span> Provider
              </legend>
              {draft.editingRoute ? (
                <div className="rounded-lg border border-gray-200 bg-white px-3 py-2.5">
                  <span className="block text-sm font-medium text-gray-900">{selectedPreset?.label ?? "Custom OpenAI-compatible API"}</span>
                  <span className="text-[11px] text-gray-500">Connection type and ID stay fixed after creation.</span>
                </div>
              ) : (
                <label className="block text-xs font-medium text-gray-700">
                  Connection type <span className="text-red-600">*</span>
                  <select className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm shadow-sm focus:border-[#0078D4] focus:outline-none focus:ring-2 focus:ring-[#0078D4]/15" value={draft.connectionType} onChange={(event) => selectConnectionType(event.target.value)}>
                    {presets.map((preset) => <option key={preset.route} value={preset.route}>{preset.label} — {preset.description}</option>)}
                    <option value="custom">Custom OpenAI-compatible API</option>
                  </select>
                </label>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                {isCustom && (
                  <label className="block text-xs font-medium text-gray-700">
                    Connection ID <span className="text-red-600">*</span>
                    <Input className="mt-1 font-mono" placeholder="company-ai" value={draft.route} disabled={Boolean(draft.editingRoute)} onChange={(event) => {
                      const route = event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-")
                      setDraft((current) => current ? { ...current, route, apiKeyEnv: current.editingRoute ? current.apiKeyEnv : `${route.replace(/-/g, "_").toUpperCase()}_API_KEY` } : null)
                      setDraftResult(null)
                    }} />
                    <FieldHelp>Internal name using lowercase letters, numbers, and dashes.</FieldHelp>
                  </label>
                )}
                <label className={`block text-xs font-medium text-gray-700 ${isCustom ? "" : "sm:col-span-2"}`}>
                  Display name <span className="font-normal text-gray-400">(optional)</span>
                  <Input className="mt-1" placeholder={selectedPreset?.label ? `${selectedPreset.label} for Analytics` : "Company AI Gateway"} value={draft.label} onChange={(event) => updateDraft("label", event.target.value)} />
                </label>
              </div>
            </fieldset>

            <fieldset className="space-y-3 border-t border-gray-200 pt-4">
              <legend className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-gray-500">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-200 text-[10px] text-gray-700">2</span> Credentials and endpoint
              </legend>

              {isCustom && (
                <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs text-blue-900">
                  <p className="font-semibold">How to fill an OpenAI-compatible connection</p>
                  <ul className="mt-1.5 space-y-1 leading-4 text-blue-800">
                    <li><strong>Base URL:</strong> API root only, usually ending in <code>/v1</code>. Do not include <code>/chat/completions</code>.</li>
                    <li><strong>Model ID:</strong> exact ID returned by the server&apos;s <code>GET /models</code>.</li>
                    <li><strong>Local server:</strong> the URL must be reachable from this deployment, not only from your browser.</li>
                    <li><strong>No key required:</strong> enter a non-sensitive placeholder such as <code>local</code>.</li>
                  </ul>
                  <div className="mt-2 rounded bg-white/80 px-2 py-1.5 font-mono text-[11px] text-blue-900">Example: https://ai.company.com/v1 · model: company-chat</div>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                {isCustom && (
                  <>
                    <label className="block text-xs font-medium text-gray-700 sm:col-span-2">
                      API Base URL <span className="text-red-600">*</span>
                      <Input className="mt-1 font-mono" type="url" placeholder="https://gateway.example.com/v1" value={draft.baseUrl} onChange={(event) => updateDraft("baseUrl", event.target.value)} />
                      <FieldHelp>The app checks <code>{"<Base URL>"}/models</code> from the server.</FieldHelp>
                    </label>
                    <label className="block text-xs font-medium text-gray-700 sm:col-span-2">
                      API format <span className="text-red-600">*</span>
                      <select className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm shadow-sm focus:border-[#0078D4] focus:outline-none focus:ring-2 focus:ring-[#0078D4]/15" value={draft.api} onChange={(event) => updateDraft("api", event.target.value)}>
                        {protocols.map((protocol) => <option key={protocol} value={protocol}>{PROTOCOL_LABELS[protocol] ?? protocol}</option>)}
                      </select>
                    </label>
                  </>
                )}

                {!isCustom && selectedPreset && (
                  <div className="sm:col-span-2 rounded-lg border border-gray-200 bg-white px-3 py-2.5">
                    <span className="block text-xs font-medium text-gray-700">API endpoint managed automatically</span>
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-gray-500">{selectedPreset.baseUrl}</span>
                  </div>
                )}

                <label className="block text-xs font-medium text-gray-700 sm:col-span-2">
                  API key <span className="text-red-600">*</span>
                  <Input className="mt-1 font-mono" type="password" autoComplete="new-password" placeholder={draft.credentialConfigured ? "Saved key will be reused — enter only to replace it" : selectedPreset?.apiKeyPlaceholder ?? "API key"} value={draft.apiKey} onChange={(event) => updateDraft("apiKey", event.target.value)} />
                  <FieldHelp>{draft.credentialConfigured ? "A key is already saved. Leave blank to keep using it." : "Stored encrypted and never returned to the browser."}</FieldHelp>
                </label>
              </div>
            </fieldset>

            <fieldset className="space-y-3 border-t border-gray-200 pt-4">
              <legend className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-gray-500">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-200 text-[10px] text-gray-700">3</span> Model and default
              </legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {isCustom ? (
                  <label className="block text-xs font-medium text-gray-700 sm:col-span-2">
                    Model IDs <span className="text-red-600">*</span>
                    <Input className="mt-1 font-mono" placeholder="company-chat, company-reasoning" value={draft.models} onChange={(event) => updateDraft("models", event.target.value)} />
                    <FieldHelp>Separate multiple exact model IDs with commas or spaces.</FieldHelp>
                  </label>
                ) : (
                  <label className="block text-xs font-medium text-gray-700 sm:col-span-2">
                    Model ID <span className="font-normal text-gray-400">(optional)</span>
                    <Input className="mt-1 font-mono" placeholder="Leave blank to use the provider default" value={draft.defaultModel} onChange={(event) => updateDraft("defaultModel", event.target.value)} />
                    <FieldHelp>Use the exact API model ID, not the display name.</FieldHelp>
                  </label>
                )}

                {isCustom && (
                  <label className="block text-xs font-medium text-gray-700">
                    Default model <span className="font-normal text-gray-400">(optional)</span>
                    <Input className="mt-1 font-mono" placeholder="First model ID above" value={draft.defaultModel} onChange={(event) => updateDraft("defaultModel", event.target.value)} />
                  </label>
                )}

                <label className={`flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-xs text-gray-700 ${isCustom ? "" : "sm:col-span-2"}`}>
                  <input type="checkbox" className="h-4 w-4 rounded border-gray-300 text-[#0078D4]" checked={draft.isDefault} onChange={(event) => updateDraft("isDefault", event.target.checked)} />
                  Use this connection for new conversations
                </label>
              </div>
            </fieldset>

            {draftResult && <ResultMessage result={draftResult} />}

            <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 pt-4">
              <Button variant="outline" onClick={() => void checkConnection(draft, "draft")} disabled={actionBusy}>
                {testingTarget === "draft" ? <Loader2 className="animate-spin" /> : <PlugZap />} Check connection
              </Button>
              <Button onClick={() => void save()} disabled={actionBusy}>
                {saving ? <Loader2 className="animate-spin" /> : <Check />} Save connection
              </Button>
              <Button variant="ghost" onClick={() => { setDraft(null); setDraftResult(null); setError(null) }} disabled={actionBusy}>Cancel</Button>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}

        <p className="flex items-start gap-1.5 text-[11px] leading-4 text-gray-500">
          <Check className="mt-0.5 h-3 w-3 shrink-0" /> Changes apply to new conversations. An open conversation restarts on its next message.
        </p>
      </CardContent>
    </Card>
  )
}
