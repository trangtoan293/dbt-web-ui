import { proxyRequest } from '@/lib/api/proxy'
import { resolveRoutes } from '@/lib/ai-providers'
import { getSessionOrNull } from '@/lib/session'

/**
 * The dbt assistant. The address is internal and defaulted, like dbt-runner's:
 * a deployment turns the feature off by setting AGENT_URL empty, and the panel
 * then hides itself instead of failing on every keystroke.
 */
async function proxyAgent(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params

  // The user's own providers and their keys, attached here and nowhere else:
  // they never reach the browser, and dsh-agent never reads the database. A user
  // who configured nothing falls back to whatever the deployment gave the agent.
  const session = await getSessionOrNull()
  const routes = session?.user?.id ? await resolveRoutes(session.user.id) : null

  const headers: Record<string, string> = {}
  if (routes && Object.keys(routes.credentials).length > 0) {
    // Base64 because these are JSON documents, and one of them holds secrets:
    // a header value must survive whatever they contain.
    headers['X-Model-Credentials'] = Buffer.from(JSON.stringify(routes.credentials)).toString('base64')
  }
  if (routes && Object.keys(routes.providers).length > 0) {
    headers['X-Model-Providers'] = Buffer.from(JSON.stringify(routes.providers)).toString('base64')
  }
  if (routes?.route) headers['X-Model-Route'] = routes.route
  if (routes?.model) headers['X-Model-Name'] = routes.model

  return proxyRequest(
    request,
    path,
    process.env.AGENT_URL ?? 'http://dsh-agent:8090',
    'agent',
    Object.keys(headers).length > 0 ? headers : undefined,
  )
}

export const GET = proxyAgent
export const POST = proxyAgent
export const OPTIONS = proxyAgent
