export type DbtEnvironmentVariableType = "text" | "password"

export interface DbtEnvironmentVariable {
  id: string
  name: string
  value: string
  type: DbtEnvironmentVariableType
  /** True when the server already holds a value the browser never receives. */
  hasValue?: boolean
}

export type ProjectSettingsTab = "general" | "environments" | "variables" | "danger"
