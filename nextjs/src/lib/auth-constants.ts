// Single-user no-auth mode (LOCAL/self-host only).
// When AUTH_DISABLED=true, login is bypassed and everything resolves to a
// fixed local user. The identity below MUST match the backend's no-auth
// default (dbt-runner/app/core/auth.py) so ownership scoping lines up.
export const AUTH_DISABLED = process.env.AUTH_DISABLED === 'true'

export const LOCAL_USER = {
  sub: 'local-user',
  email: 'local@dbt-craft.local',
  name: 'Local User',
} as const
