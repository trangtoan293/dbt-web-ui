# Security

## Reporting a vulnerability

Please **do not** file a public GitHub issue for security problems.

Report privately by opening a **GitHub Security Advisory** from the
repository's **Security** tab (Report a vulnerability). This keeps the
report private until a fix is released.

We will acknowledge receipt within 3 business days and aim to ship a fix or
mitigation within 30 days for high-severity issues.

## Scope

- `nextjs/` (frontend)
- `dbt-runner/` (FastAPI backend)
- Authentication, authorization, credential storage, and project isolation.

## Out of scope

- Vulnerabilities that only affect an upstream project and are not reachable
  through this application (please report them upstream).
- Social-engineering or physical attacks.
- Load testing or denial-of-service testing against infrastructure you do not own.
- Deployments with `AUTH_DISABLED=true` exposed beyond loopback or a trusted
  local network.

## Supported versions

There is no supported tagged release yet. Until the first release, security
fixes are made on `main`. After releases begin, this section will list supported
versions explicitly.

## Deployment baseline

- Use OIDC and set `AUTH_DISABLED=false` for every network-accessible deployment.
- Use unique, randomly generated secrets and a strict `CORS_ORIGINS` allowlist.
- Terminate TLS at a maintained reverse proxy.
- Do not expose PostgreSQL or Redis to the public network.
- Enable GitHub secret scanning, push protection, Dependabot alerts, and private
  vulnerability reporting on the repository.
