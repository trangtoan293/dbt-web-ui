/**
 * The origin the browser actually used.
 *
 * `request.url` is the origin the server bound to, which in a container is
 * `http://0.0.0.0:3000`. Redirecting a browser there sends it to a different
 * origin — cookies do not apply and an identity provider will reject it as an
 * unregistered redirect URI. Always resolve the public origin instead.
 */
export function publicOrigin(request: Request): string {
  const configured = process.env.NEXTAUTH_URL
  if (configured) {
    return configured.replace(/\/$/, '')
  }

  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  if (host) {
    const proto =
      request.headers.get('x-forwarded-proto') ??
      (host.startsWith('localhost') || host.startsWith('127.0.0.1')
        ? 'http'
        : 'https')
    return `${proto}://${host}`
  }

  return new URL(request.url).origin
}
