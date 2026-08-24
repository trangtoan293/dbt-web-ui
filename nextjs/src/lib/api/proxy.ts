import { isMalformedBearerHeader } from '@/lib/auth-headers'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * Forward a browser request to an internal service, streaming the response.
 *
 * The browser never holds a service address: it calls this route, which is the
 * only place that knows where the service lives. The response body is passed
 * through unbuffered so SSE endpoints stream rather than arrive at the end.
 */
export async function proxyRequest(
  request: Request,
  path: string[],
  targetBaseUrl: string | undefined,
  serviceName: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  if (!targetBaseUrl) {
    return Response.json(
      { error: `${serviceName} is not configured` },
      { status: 503 },
    )
  }

  const sourceUrl = new URL(request.url)
  const targetUrl = new URL(path.join('/'), `${targetBaseUrl.replace(/\/$/, '')}/`)
  targetUrl.search = sourceUrl.search

  const headers = new Headers(request.headers)
  if (isMalformedBearerHeader(headers.get('authorization'))) {
    return Response.json(
      { error: 'Malformed Authorization header' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    )
  }
  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header)
  }
  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    // Set, never append: a client-supplied header of the same name must not
    // survive alongside the one this route is adding.
    headers.set(name, value)
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer()
  }

  let response: Response
  try {
    response = await fetch(targetUrl, init)
  } catch {
    // Not running, or not reachable from here. A caller polling for
    // availability wants an answer, not a 500 page.
    return Response.json(
      { error: `${serviceName} is not reachable` },
      { status: 503 },
    )
  }
  const responseHeaders = new Headers(response.headers)
  for (const header of HOP_BY_HOP_HEADERS) {
    responseHeaders.delete(header)
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  })
}
