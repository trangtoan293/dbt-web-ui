/**
 * Shapes the IDE passes between its own components.
 *
 * They used to live beside hooks that no longer exist: useProject, useFileTree
 * and useEditor were reachable only from a ProjectProvider nothing mounted.
 * The types outlived them because the components do use them.
 */

export interface DbtProject {
  id: string
  name: string
  description: string | null
  git_url: string | null
  git_branch: string
  sync_status: string
  dremio_source_id: string | null
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

export interface OpenTab {
  path: string
  name: string
  content: string
  originalContent: string
  isDirty: boolean
  isDraft?: boolean
}
