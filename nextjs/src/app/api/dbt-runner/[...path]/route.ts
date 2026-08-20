import { getDbtRunnerUrl } from '@/lib/api/client'
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

async function proxyDbtRunner(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params
  const sourceUrl = new URL(request.url)
  const targetBaseUrl = getDbtRunnerUrl()
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

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer()
  }

  const response = await fetch(targetUrl, init)
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

export const GET = proxyDbtRunner
export const POST = proxyDbtRunner
export const PUT = proxyDbtRunner
export const PATCH = proxyDbtRunner
export const DELETE = proxyDbtRunner
export const OPTIONS = proxyDbtRunner
