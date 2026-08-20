# Frontend

The **Next.js 15** frontend for [dbt-craft](../README.md), a browser-based dbt IDE.

## Stack

- Next.js 15 (App Router) + React 19 + TypeScript
- Prisma 6 against PostgreSQL 16
- NextAuth v5 with a generic OIDC provider
- Monaco editor, Tailwind CSS
- Vitest

## Commands

```bash
npm ci
npx prisma generate          # regenerate the client after a schema change
npm run dev                  # dev server on :3000 (turbopack)
npm run build                # production build (also type-checks)
npm run lint
npm run test                 # once
npm run test:watch
npm run test:setup           # create the dedicated test database
npx prisma migrate dev --name <name>
npx prisma studio            # DB GUI
```

`prisma generate` is not a postinstall hook — run it yourself after editing
`prisma/schema.prisma`.

## Layout

```
src/
├── app/
│   ├── (app)/       # authenticated app: /, /develop, /runs, /explore,
│   │                #   /connections, /settings
│   ├── (auth)/      # /login, /logout
│   ├── api/         # route handlers, incl. the dbt-runner proxy
│   ├── layout.tsx   # single root layout
│   └── globals.css
├── components-v2/   # UI: develop workspace, dashboard, connections, layout
├── lib/             # API clients, hooks, auth config, server actions
└── middleware.ts    # auth gating
prisma/
├── schema.prisma
└── migrations/
```

## Configuration

Environment variables are documented in the root [`.env.example`](../.env.example).
The browser calls the backend through the `/api/dbt-runner` proxy, which
forwards server-side to `DBT_RUNNER_URL`. The app authenticates
against the issuer in `OIDC_ISSUER` — endpoints are read from that issuer's
`/.well-known/openid-configuration`, so any spec-compliant provider works. With
`AUTH_DISABLED=true` it signs in a single fixed local user and contacts no IdP.
