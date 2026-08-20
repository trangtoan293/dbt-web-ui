import { auth } from '@/lib/auth'
import { NextResponse } from 'next/server'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string; filePath: string[] }> }
) {
  const session = await auth()
  if (!session?.user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { projectId, filePath } = await params
  const filePathStr = filePath.join('/')

  const { getDbtRunnerUrl } = await import('@/lib/api/client')
  const dbtRunnerUrl = getDbtRunnerUrl()

  const res = await fetch(`${dbtRunnerUrl}/dbt/docs/static/${projectId}/${filePathStr}`)
  if (!res.ok) {
    return new Response(res.statusText, { status: res.status })
  }

  const headers = new Headers()
  const contentType = res.headers.get('content-type')
  if (contentType) headers.set('Content-Type', contentType)

  return new NextResponse(res.body, { headers })
}
