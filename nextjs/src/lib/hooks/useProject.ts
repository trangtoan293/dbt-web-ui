import { useState, useEffect, useCallback } from 'react'
import { getProjectById, updateProject } from '@/lib/api-client'

export interface DbtProject {
  id: string
  name: string
  description: string | null
  git_url: string | null
  git_branch: string
  sync_status: string
  dremio_source_id: string | null
}

export interface UseProjectReturn {
  project: DbtProject | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  updateConnection: (connectionId: string) => Promise<boolean>
}

export function useProject(projectId: string): UseProjectReturn {
  const [project, setProject] = useState<DbtProject | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadProject = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setError(null)
    try {
      const data = await getProjectById(projectId)
      setProject(data)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load project'
      setError(message)
      console.error('Error loading project:', err)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const updateConnection = useCallback(async (connectionId: string): Promise<boolean> => {
    try {
      await updateProject(projectId, { dremioSourceId: connectionId })
      setProject(prev => prev ? { ...prev, dremio_source_id: connectionId } : null)
      return true
    } catch (err) {
      console.error('Error updating connection:', err)
      return false
    }
  }, [projectId])

  useEffect(() => { loadProject() }, [loadProject])

  return { project, loading, error, reload: loadProject, updateConnection }
}
