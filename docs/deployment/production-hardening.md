# Production hardening

The default `docker-compose.yml` is a loopback-only local stack. It is not a
complete internet-facing deployment.

`docker-compose.production.yml` is a security overlay: it removes every
published host port, forces OIDC on, and fails interpolation when a required
secret is missing.

```bash
CORS_ORIGINS='["https://app.example.com"]' \
docker compose \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  config --quiet
```

`CORS_ORIGINS` must be a JSON array, even for a single origin.

## Required architecture

Run a maintained TLS reverse proxy on the compose network and route only the
frontend. Do not publish dbt-runner, PostgreSQL, or Redis. If the browser must
reach dbt-runner directly, publish it through the same TLS proxy and set an
exact `CORS_ORIGINS` allowlist.

Use an external secret manager or Docker secrets in a real deployment. The
environment variables in the overlay are validation hooks, not a recommendation
to keep secrets in a checked-in env file.

Required controls:

- `AUTH_DISABLED=false`;
- a unique OIDC client with a strict redirect URI allowlist;
- random PostgreSQL, cookie, and application encryption keys;
- TLS, HSTS, request/body limits, access logs with secret redaction, and rate
  limiting at the proxy;
- a private network policy between services;
- encrypted database and volume backups, with a tested restore;
- container images pinned by digest, scanned before deployment, and updated
  through reviewed dependency PRs;
- GitHub branch protection, secret scanning with push protection, and private
  vulnerability reporting.

## Validate before rollout

```bash
test "${AUTH_DISABLED}" = "false"
docker compose -f docker-compose.yml -f docker-compose.production.yml config
docker compose -f docker-compose.yml -f docker-compose.production.yml pull
```

Review the rendered configuration for host ports, placeholder values, public
networks, and unexpected mounts. Deploy to a disposable environment first,
apply migrations, call the health endpoints through the proxy, exercise login
and logout, and verify that a direct connection to the data services fails.
