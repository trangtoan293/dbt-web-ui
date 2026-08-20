#!/usr/bin/env bash
# Print the random secrets required by .env.example.
# Does not write to disk — copy the values into your .env.

set -euo pipefail

gen() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }

# POSTGRES_PASSWORD is interpolated into DATABASE_URL, so keep it URL-safe.
# base64 can emit '/', '+' and '=', which break the connection string.
gen_urlsafe() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

cat <<EOF
# Copy these into your .env:

POSTGRES_PASSWORD=$(gen_urlsafe)
APP_ENCRYPTION_KEY=$(gen)
AUTH_SECRET=$(gen)

# Only needed when AUTH_DISABLED=false — this must be the client secret issued
# by your OIDC provider, not a generated value:
# OIDC_CLIENT_SECRET=
EOF
