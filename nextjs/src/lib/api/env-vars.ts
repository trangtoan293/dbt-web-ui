export type DbtEnvironmentVariableType = 'text' | 'password'

export interface DbtEnvironmentVariableMeta {
  id: string
  name: string
  type: DbtEnvironmentVariableType
  hasValue: boolean
  updatedAt: string
}

export interface DbtEnvironmentVariableInput {
  name: string
  type: DbtEnvironmentVariableType
  value?: string
  keepExisting?: boolean
}

async function parseResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : 'Environment variable request failed'
    throw new Error(message)
  }
  return data as T
}

export const envVarsApi = {
  list(projectId: string) {
    return fetch(`/api/projects/${projectId}/env-vars`).then((response) =>
      parseResponse<DbtEnvironmentVariableMeta[]>(response),
    )
  },

  replace(projectId: string, vars: DbtEnvironmentVariableInput[]) {
    return fetch(`/api/projects/${projectId}/env-vars`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vars),
    }).then((response) => parseResponse<DbtEnvironmentVariableMeta[]>(response))
  },
}
