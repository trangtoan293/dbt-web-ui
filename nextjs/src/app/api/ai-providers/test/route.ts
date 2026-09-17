import { NextResponse } from "next/server"

import { checkProviderConnection } from "@/lib/ai-provider-connection"
import { assertUrlHostAllowed } from "@/lib/host-guard"
import {
  defaultApiKeyEnv,
  readProviderCredentialForTest,
  validateProvider,
  type ProviderInput,
} from "@/lib/ai-providers"
import { getCurrentUserId } from "@/lib/session"

export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId()
    const body = await request.json().catch(() => ({})) as ProviderInput
    if (typeof body?.route !== "string") {
      return NextResponse.json({ error: "Provider is required" }, { status: 400 })
    }

    const problem = validateProvider(body)
    if (problem) return NextResponse.json({ error: problem }, { status: 400 })

    // The server fetches this URL, so it is the same surface dbt-runner guards
    // for connection hosts. A preset's own endpoint is ours; only an override
    // is user input. The fetch itself sets redirect: "error", so a public URL
    // cannot bounce into the private range afterwards.
    const overrideUrl = body.baseUrl?.trim()
    if (overrideUrl) await assertUrlHostAllowed(overrideUrl)

    const credentialName = (body.apiKeyEnv ?? defaultApiKeyEnv(body.route)).trim()
    const apiKey = body.apiKey?.trim() || await readProviderCredentialForTest(
      userId,
      body.route.trim(),
      credentialName,
      body.baseUrl,
    )
    if (!apiKey) {
      return NextResponse.json({
        error: "Enter an API key to check this connection. An existing saved key can also be reused.",
      }, { status: 400 })
    }

    const result = await checkProviderConnection({
      route: body.route.trim(),
      apiKey,
      baseUrl: body.baseUrl,
      defaultModel: body.defaultModel || body.models?.[0]?.id,
    })
    return NextResponse.json(result)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Could not check connection"
    const status = message === "Not authenticated" ? 401 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
