import { proxyRequest } from "@/lib/api/proxy"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = ((input: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init })
    return Promise.resolve(response)
  }) as typeof fetch
  return calls
}

describe("service proxy", () => {
  it("answers 503 when the service is not configured, without calling anything", async () => {
    const calls = stubFetch(new Response("unreachable"))

    const response = await proxyRequest(
      new Request("http://localhost:3000/api/agent/health"),
      ["health"],
      undefined,
      "agent",
    )

    expect(response.status).toBe(503)
    expect(calls).toHaveLength(0)
    expect(await response.json()).toEqual({ error: "agent is not configured" })
  })

  it("refuses a malformed Authorization header before forwarding it", async () => {
    const calls = stubFetch(new Response("ok"))

    const response = await proxyRequest(
      new Request("http://localhost:3000/api/agent/health", {
        headers: { authorization: "Bearer" },
      }),
      ["health"],
      "http://agent:8090",
      "agent",
    )

    expect(response.status).toBe(401)
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer")
    expect(calls).toHaveLength(0)
  })

  it("forwards path, query and bearer to the service", async () => {
    const calls = stubFetch(new Response("[]"))

    await proxyRequest(
      new Request("http://localhost:3000/api/agent/agent/p1/prompt?x=1", {
        method: "POST",
        headers: { authorization: "Bearer abc", "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      }),
      ["agent", "p1", "prompt"],
      "http://agent:8090/",
      "agent",
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://agent:8090/agent/p1/prompt?x=1")
    const headers = calls[0].init.headers as Headers
    expect(headers.get("authorization")).toBe("Bearer abc")
    // Hop-by-hop headers belong to one connection and must not be relayed.
    expect(headers.get("connection")).toBeNull()
    expect(headers.get("content-length")).toBeNull()
  })

  it("attaches the caller's model key, overriding one the browser tried to set", async () => {
    const calls = stubFetch(new Response("ok"))

    await proxyRequest(
      new Request("http://localhost:3000/api/agent/agent/p1/prompt", {
        method: "POST",
        // A browser must not be able to choose which key the agent uses.
        headers: { "x-model-api-key": "sk-spoofed-by-the-client" },
      }),
      ["agent", "p1", "prompt"],
      "http://agent:8090",
      "agent",
      { "X-Model-Api-Key": "sk-from-the-server" },
    )

    const headers = calls[0].init.headers as Headers
    expect(headers.get("x-model-api-key")).toBe("sk-from-the-server")
  })

  it("sends no model key header when the user has none", async () => {
    const calls = stubFetch(new Response("ok"))

    await proxyRequest(
      new Request("http://localhost:3000/api/agent/health"),
      ["health"],
      "http://agent:8090",
      "agent",
    )

    expect((calls[0].init.headers as Headers).get("x-model-api-key")).toBeNull()
  })

  it("streams the response body instead of buffering it, so SSE arrives live", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"text"}\n\n'))
        // Deliberately left open: a buffering proxy would never resolve here.
      },
    })
    stubFetch(new Response(stream, { headers: { "content-type": "text/event-stream" } }))

    const response = await proxyRequest(
      new Request("http://localhost:3000/api/agent/agent/p1/prompt", { method: "POST" }),
      ["agent", "p1", "prompt"],
      "http://agent:8090",
      "agent",
    )

    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('"type":"text"')
    await reader.cancel()
  })
})
