import { auth } from '@/lib/auth'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { projectId } = await params

  const { getDbtRunnerUrl } = await import('@/lib/api/client')
  const dbtRunnerUrl = getDbtRunnerUrl()

  const res = await fetch(`${dbtRunnerUrl}/dbt/docs/view/${projectId}`)
  if (!res.ok) {
    return new Response(res.statusText, { status: res.status })
  }

  let html = await res.text()
  html = html.replace(
    /\/dbt\/docs\/static\//g,
    `/api/dbt-docs/static/`
  )

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
