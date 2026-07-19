# Agentic Orchestration Deployment

Production topology:

```text
Frontend (Vercel) -- REST/Socket.IO --> NestJS backend (Render) -- HTTPS --> Eve agent service (Render)
                                           |
                                           +--> Supabase Postgres/Auth/pgvector
```

The frontend talks only to the backend. Supabase hosts Postgres and Auth, but the backend owns orchestration state, role checks, run control, sockets, GitHub delivery, provider calls, and recovery. The Eve service is server-to-server only and must not be called from the browser.

## Supabase

Create the production Supabase project first.

Required setup:

- Enable Auth providers, starting with GitHub for the current production path.
- Enable `pgvector` for agent memory embeddings.
- Keep service schemas private to the backend. Do not expose orchestration tables through the Supabase Data API unless a deliberate RLS and grant design is added.
- Record `SUPABASE_URL`, frontend publishable/anon key, backend service-role key, pooled database URL, and direct database URL.

Supabase's newer platform defaults require explicit grants for tables that should be reachable through the Data API. This app avoids that dependency for orchestration data: Vercel uses public Supabase Auth values, and business data flows through the Render backend.

## Backend: Render Web Service

Deploy `agentic-orchestration-be` as a Render Web Service.

Build command:

```bash
./render-build.sh
```

Start command:

```bash
npm run start
```

Required production env:

```env
DATABASE_URL="postgresql://..."
DIRECT_URL="postgresql://..."
SUPABASE_URL="https://<project-ref>.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="..."
AUTH_ALLOWED_PROVIDERS="github"
AGENT_PROVIDER="llm"
ORCHESTRATION_LLM_ENGINE="eve"
ORCHESTRATION_DISPATCHER_MODE="db-lease"
EVE_SERVICE_URL="https://<agent-service>.onrender.com"
EVE_SERVICE_TOKEN="..."
CORS_ORIGIN="https://<frontend-domain>"
GITHUB_APP_ID="..."
GITHUB_PRIVATE_KEY="..."
GITHUB_INSTALLATION_ID="..."
GITHUB_ORG="..."
```

Provider env depends on the selected direct fallback provider:

```env
LLM_PROVIDER="openrouter"
OPENROUTER_API_KEY="..."
OPENROUTER_MODEL="..."
OPENAI_API_KEY="..."
```

`DATABASE_URL` is used by the running backend. `DIRECT_URL` is used by Prisma CLI migration/introspection commands. If production uses a pooled Supabase runtime URL, `DIRECT_URL` must be the direct/non-pooling Supabase Postgres URL.

Release-only env for schema verification:

```env
SUPABASE_PROJECT_REF="<project-ref>"
SUPABASE_ACCESS_TOKEN="sbp_..."
```

`SUPABASE_ACCESS_TOKEN` is a Supabase Management API token. Keep it in the CI/release job environment, not in the frontend.

## Prisma Release Step

Prisma Client is generated during the backend build. Prisma migrations are a separate release step and should not run in every app startup.

Run this before releasing a backend version:

```bash
npm ci
npm run prisma:generate
npm run deploy:release
```

`npm run deploy:release` runs:

```bash
npm run prisma:migrate
npm run verify:supabase-schema
```

Use `prisma migrate deploy` in production. Do not use `prisma migrate dev` against production Supabase.

## Eve Service: Render Web Service

Deploy `agentic-orchestration-ag` as a separate Render Web Service.

Render settings:

```bash
Build command: npm ci && npm test && npm run typecheck && npm run build
Start command: npm run start
```

Required env:

```env
NODE_VERSION="24"
EVE_SERVICE_TOKEN="<same value as backend>"
EVE_MODEL="openai/gpt-5.4-mini"
```

Optional per-agent model overrides:

```env
EVE_BACKEND_MODEL=""
EVE_FRONTEND_MODEL=""
EVE_DATABASE_MODEL=""
EVE_ARCHITECTURE_MODEL=""
EVE_REQUIREMENTS_MODEL=""
EVE_CONTRACT_MODEL=""
EVE_CRITIQUE_MODEL=""
```

After Render assigns the service URL, set backend `EVE_SERVICE_URL` to that URL.

## Frontend: Vercel

Deploy `agentic-orchestration-fe` to Vercel.

Required env:

```env
NEXT_PUBLIC_API_URL="https://<backend-service>.onrender.com"
NEXT_PUBLIC_SOCKET_URL="https://<backend-service>.onrender.com"
NEXT_PUBLIC_SUPABASE_URL="https://<project-ref>.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="..."
NEXT_PUBLIC_AUTH_REDIRECT_PATH="/client/sign-in"
```

Only `NEXT_PUBLIC_*` browser-safe values belong in the frontend. Never put `SUPABASE_SERVICE_ROLE_KEY`, database URLs, GitHub private keys, Eve secrets, or model provider keys in Vercel frontend env.

After Vercel gives the production URL, update backend `CORS_ORIGIN` to the exact frontend origin.

## Rollout Order

1. Create Supabase project and configure Auth/provider settings.
2. Deploy Eve service on Render and copy its URL.
3. Configure backend env on Render, including `EVE_SERVICE_URL`.
4. Run backend Prisma release step: `npm run deploy:release`.
5. Deploy backend on Render.
6. Deploy frontend on Vercel with backend and Supabase public env.
7. Tighten backend `CORS_ORIGIN` to the Vercel production origin.
8. Run production smoke checks.

## Smoke Checks

Backend readiness:

```bash
npm run deploy:smoke
```

Manual production checks:

- Supabase Auth login succeeds.
- `GET /auth/me` returns the expected backend profile and role.
- Frontend API calls reach the Render backend.
- Socket.IO connects to `NEXT_PUBLIC_SOCKET_URL`.
- `GET /health/orchestration` reports database, auth, dispatcher, Eve, provider, GitHub, and outbox readiness.
- Starting a test orchestration run creates durable `orchestration_runs` and `orchestration_jobs` rows.
- The run reaches the expected gate or delivery state.

Rollback options:

- Set `ORCHESTRATION_LLM_ENGINE="direct"` to bypass Eve and use direct provider credentials.
- Revert the backend service to the previous Render deploy if a code release fails.
- Do not roll back database migrations without a dedicated reverse migration.
