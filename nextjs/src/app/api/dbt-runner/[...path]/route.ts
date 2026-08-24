import { proxyRequest } from '@/lib/api/proxy'

async function proxyDbtRunner(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params
  return proxyRequest(
    request,
    path,
    process.env.DBT_RUNNER_URL || 'http://localhost:8080',
    'dbt-runner',
  )
}

export const GET = proxyDbtRunner
export const POST = proxyDbtRunner
export const PUT = proxyDbtRunner
export const PATCH = proxyDbtRunner
export const DELETE = proxyDbtRunner
export const OPTIONS = proxyDbtRunner
