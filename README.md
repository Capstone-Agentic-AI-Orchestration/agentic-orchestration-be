# Agentic Orchestration Backend

`agentic-orchestration-be` is the NestJS API for the migrated Agentic Orchestration product. It serves the PM, DEV, CLIENT, and ADMIN workspaces used by `agentic-orchestration-fe`.

The current production-ready surface is the project delivery lifecycle around intake, client invites, kickoff, tasks, work orders, artifacts, collaboration, timeline, notifications, delivery review, and async orchestration. `agentic-orchestration-be` is the control plane: it owns auth, run state, gates, validation, persistence, streaming, and GitHub delivery. Agent execution is delegated through the provider layer, with Eve in `agentic-orchestration-ag` as the target execution plane.

## Prerequisites

| Tool | Version |
| --- | --- |
| Node.js | 22.x |
| npm | 10.x |
| PostgreSQL | Supabase Postgres or local PostgreSQL |
| Supabase | Auth + Postgres project |

## Setup

```powershell
npm install
Copy-Item .env.example .env
docker compose up -d db
npm run prisma:generate
npm run prisma:migrate
npm run build
npm run start
```

The API listens on `http://localhost:4000` by default. Health check:

```powershell
Invoke-RestMethod http://localhost:4000/health
```

For hot reload during development:

```powershell
npm run start:dev
```

## Environment

Required:

```env
DATABASE_URL="postgresql://..."
DIRECT_URL="postgresql://..."
SUPABASE_URL="https://your-project-ref.supabase.co"
```

`DATABASE_URL` is the backend runtime connection. `DIRECT_URL` is the direct Postgres connection Prisma CLI uses for migrations and introspection; in local development it can match `DATABASE_URL`. In Supabase production, use the direct/non-pooling connection string for `DIRECT_URL` when `DATABASE_URL` uses the pooled connection.

Release-only schema verification values:

```env
SUPABASE_PROJECT_REF="your-project-ref"
SUPABASE_ACCESS_TOKEN="sbp_..."
```

Common optional values:

```env
AGENT_PROVIDER="mock"
ORCHESTRATION_LLM_ENGINE="eve"
ORCHESTRATION_DISPATCHER_MODE="db-lease"
EVE_SERVICE_URL=""
EVE_SERVICE_TOKEN=""
LLM_PROVIDER="openrouter"
LLM_REQUEST_TIMEOUT_MS=120000
LLM_CONCURRENCY_LIMIT=4
OPENROUTER_API_KEY=""
OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"
OPENROUTER_MODEL="deepseek/deepseek-v4-flash:free"
OPENROUTER_FALLBACK_MODEL="nvidia/nemotron-3-nano-30b-a3b:free"
OPENAI_BASE_URL="https://api.openai.com/v1"
OPENAI_MODEL="gpt-4.1-mini"
OPENAI_FALLBACK_MODEL=""
OPENAI_API_KEY=""
OPENCODE_BASE_URL="https://opencode.ai/zen/go/v1"
OPENCODE_MODEL="deepseek-v4-flash"
OPENCODE_FALLBACK_MODEL="deepseek-v4-pro"
OPENCODE_API_KEY=""
ANTHROPIC_BASE_URL="https://api.anthropic.com/v1"
ANTHROPIC_MODEL="claude-3-5-haiku-20241022"
ANTHROPIC_FALLBACK_MODEL=""
ANTHROPIC_VERSION="2023-06-01"
ANTHROPIC_API_KEY=""
GEMINI_BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai"
GEMINI_MODEL="gemini-3.5-flash"
GEMINI_FALLBACK_MODEL=""
GEMINI_API_KEY=""
PORT=4000
NODE_ENV="development"
CORS_ORIGIN="http://localhost:3001"
SUPABASE_SERVICE_ROLE_KEY=""
SUPABASE_ANON_KEY=""
CLIENT_APP_URL="http://localhost:3000"
AUTH_ALLOWED_PROVIDERS="github"
# Alternate provider keys. The direct provider and work-order agents use OpenRouter by default.
GITHUB_APP_ID=""
GITHUB_PRIVATE_KEY=""
GITHUB_INSTALLATION_ID=""
GITHUB_ORG=""
LANGCHAIN_API_KEY=""
LANGCHAIN_TRACING_V2="false"
LANGCHAIN_PROJECT="devflow"
OUTBOX_RELAY_ENABLED="false"
OUTBOX_RELAY_INTERVAL_MS=10000
OUTBOX_RELAY_BATCH_SIZE=25
OUTBOX_RELAY_LOCK_MS=60000
OUTBOX_RELAY_MAX_ATTEMPTS=5
```

`SUPABASE_SERVICE_ROLE_KEY` is server-side only. Never expose it to `agentic-orchestration-fe`.
It is also used to send a Supabase account invitation when a PM approves a new client inquiry.
Set `CLIENT_APP_URL` to the deployed `alphaexplora-client-fe` origin and allow that origin under
Supabase Authentication URL Configuration. If delivery fails, the approval remains committed and
the PM can resend the account email from the Approved inquiries list.

For production recipients, configure custom SMTP under Supabase Authentication. Supabase's default
SMTP service is intended only for testing and may reject addresses outside the project team.

DevFlow login uses Supabase Auth. For the current GitHub OAuth-only rollout, configure GitHub as a Supabase Auth provider and keep `AUTH_ALLOWED_PROVIDERS="github"` on Render. When Google is enabled later, set `AUTH_ALLOWED_PROVIDERS="github,google"`. See `docs/setup/github-oauth-render-vercel.md` for the full Supabase, Render, and Vercel setup.

`AGENT_PROVIDER=mock` runs the deterministic local orchestration provider and does not require LLM or GitHub credentials. Use `AGENT_PROVIDER=llm` with `ORCHESTRATION_LLM_ENGINE=eve` and `EVE_SERVICE_URL` to delegate generation turns to `agentic-orchestration-ag`. If Eve is not configured or fails preflight before a run starts, the router explicitly falls back to the in-process direct provider and uses `LLM_PROVIDER` credentials; it does not silently switch engines mid-turn after a partial Eve stream. OpenCode-only mode is `AGENT_PROVIDER=llm` plus `ORCHESTRATION_LLM_ENGINE=direct`, `LLM_PROVIDER=opencode`, and `OPENCODE_API_KEY`. If OpenRouter is throttled, `LLM_PROVIDER=opencode` with `OPENCODE_API_KEY`, `LLM_PROVIDER=openai` with `OPENAI_API_KEY`, `LLM_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`, or `LLM_PROVIDER=gemini` with `GEMINI_API_KEY` uses an alternate direct provider instead. The default OpenRouter model is `deepseek/deepseek-v4-flash:free`; the default OpenCode model is `deepseek-v4-flash`; the default OpenAI model is `gpt-4.1-mini`; the default Anthropic model is `claude-3-5-haiku-20241022`; the default Gemini model is `gemini-3.5-flash`. `LLM_REQUEST_TIMEOUT_MS` and `LLM_CONCURRENCY_LIMIT` apply across Eve calls and direct/work-order model calls.

The orchestration path defines DevFlow's own agents: requirements parser, contract negotiator, frontend, backend, database, architecture, validator, and GitHub commit. NestJS controls ordering, parallel fan-out, retries, human approval gates, and durable run state. Eve, OpenRouter, OpenCode, OpenAI, Anthropic, or Gemini only supply model execution inside those custom agents. LLM generation can start before GitHub App delivery is configured; after Gate 2 approval, the GitHub commit node requires GitHub readiness, creates a private repository through the configured GitHub App, commits generated artifacts, injects CI, and stores `repoUrl` on the project.

`ORCHESTRATION_DISPATCHER_MODE=db-lease` means the API writes durable `OrchestrationJob` rows, workers claim due jobs with compare-and-swap locks, and the run row carries a second lease so duplicate workers cannot drive the same run. `ORCHESTRATION_DISPATCHER_MODE=in-process` remains available for local/dev compatibility only.

GitHub delivery requires `GITHUB_APP_ID`, a valid PEM `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, and `GITHUB_ORG`. `GITHUB_PRIVATE_KEY` can be base64-encoded PEM, raw PEM, or escaped-newline PEM; the app normalizes it before validating it. The orchestration provider endpoint includes `githubDelivery` readiness details so the app can show missing setup before Gate 2 delivery fails. The project orchestration API also exposes non-destructive live checks for the selected LLM provider and GitHub App delivery credentials, and the PM project view surfaces both checks before a real orchestration-to-GitHub run. `npm run smoke:github` performs the same GitHub App installation owner and repository access verification before it allows a real smoke repository create.

`GET /health/orchestration` returns operator readiness sections for database, Supabase/auth config, dispatcher mode, Eve reachability/auth, direct provider key/model readiness, GitHub delivery, and outbox relay state.

`npm run smoke:orchestration-readiness` is non-destructive and verifies the selected LLM provider plus GitHub App delivery credentials without creating a project or repository. It exits successfully while reporting blockers by default; set `ORCHESTRATION_READINESS_STRICT=true` when you want CI to fail on incomplete readiness. `npm run smoke:direct-github` is safe by default and skips before creating a repository. Set `DIRECT_GITHUB_SMOKE_CREATE=true` only when you intentionally want a real end-to-end smoke repository created through the full Gate 1 -> Gate 2 -> GitHub delivery flow. The destructive live smoke preflights OpenRouter, OpenCode, OpenAI, Anthropic, and Gemini and uses the first configured provider that accepts a real request; set `DIRECT_GITHUB_SMOKE_PROVIDER_AUTO=false` to test only the configured `LLM_PROVIDER`. The old `LANGGRAPH_GITHUB_SMOKE_*` variables and `npm run smoke:langgraph-github` command remain temporary deprecated aliases.

`OUTBOX_RELAY_ENABLED=false` keeps integration events durable in Postgres without publishing them. Enable it only for local contract testing until `OUTBOX_PUBLISHER` is replaced with a durable broker-backed publisher.

State-changing intake endpoints accept `Idempotency-Key`. Reusing the same key and same request body returns the stored response; reusing a key with a different body returns `400`; replaying while the first request is still processing returns `409`.

## Scripts

```powershell
npm test              # Vitest unit/regression tests
npm run build         # Compile NestJS to dist/
npm run deploy:build  # Generate Prisma Client and compile the backend
npm run deploy:release # Apply migrations and verify the live Supabase schema
npm run deploy:smoke  # Run non-destructive orchestration readiness smoke
npm run start         # Run compiled output
npm run start:dev     # Development server
npm run prisma:migrate      # Apply checked-in SQL migrations
npm run prisma:migrate:dev  # Create Prisma-authored migrations when needed
npm run prisma:generate
npm run prisma:studio
npm run auth:set-role
npm run seed:demo
npm run seed:demo:check
npm run seed:demo:smoke
npm run smoke:openrouter
npm run smoke:github
npm run smoke:orchestration-readiness
npm run smoke:direct-github
npm run smoke:langgraph-github  # deprecated alias
```

## Persona Demo Data

The repeatable demo seed creates PM, DEV, and CLIENT records against real Supabase Auth/Profile data.

Default demo users:

| Persona | Email | Role |
| --- | --- | --- |
| PM | `devflow.pm@example.com` | `PM` |
| Developer | `devflow.dev@example.com` | `DEV` |
| Client | `devflow.client@example.com` | `CLIENT` |

If `SUPABASE_SERVICE_ROLE_KEY` is set, missing default auth users are created through Supabase Auth Admin. If only `SUPABASE_ANON_KEY` is set and public signup is enabled, missing users are created through public signup. Otherwise the seed reuses existing profiles for each role.

```powershell
npm run seed:demo
npm run seed:demo:check
```

With the API running and `SUPABASE_ANON_KEY` available:

```powershell
npm run seed:demo:smoke
```

The smoke signs in as each persona and validates positive access plus forbidden cross-role access.

Optional seed overrides:

```env
DEMO_PROJECT_ID="demo-persona-project"
DEMO_PM_EMAIL="devflow.pm@example.com"
DEMO_DEV_EMAIL="devflow.dev@example.com"
DEMO_CLIENT_EMAIL="devflow.client@example.com"
DEMO_AUTH_PASSWORD="DevFlowDemo123!"
```

## Current API Surface

All protected endpoints expect `Authorization: Bearer <Supabase access token>`.

Public:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health probe |
| `GET` | `/health/live` | Liveness probe |
| `GET` | `/health/ready` | Readiness probe with database check |
| `POST` | `/inquiries` | Public project inquiry |
| `GET` | `/client-invites/status?email=...` | Public invite status lookup |

Authenticated:

| Area | Representative endpoints |
| --- | --- |
| Auth | `GET /auth/me` |
| Projects | `GET /projects`, `POST /projects`, `GET/PATCH /projects/:id` |
| Members | `POST /projects/:id/members`, `DELETE /projects/:id/members/:userId` |
| Kickoff | `GET/PATCH /projects/:id/kickoff`, `POST /projects/:id/kickoff/tasks`, `POST /projects/:id/kickoff/work-orders` |
| Tasks | `GET/POST /projects/:id/tasks`, `PATCH /projects/:id/tasks/:taskId`, comments/activity endpoints |
| Work orders | `GET/POST /projects/:id/work-orders`, `PATCH /projects/:id/work-orders/:workOrderId`, `POST /projects/:id/work-orders/:workOrderId/dispatch` |
| Artifacts | `GET /projects/:id/artifacts`, artifact detail, share, review, output review, publish, revision endpoints |
| Collaboration | conversations, messages, read state, documents, document review under `/projects/:projectId/...` |
| Delivery | `GET /projects/:id/delivery-review`, accept/revision/resolve endpoints |
| Timeline/events | `GET /projects/:id/timeline`, `GET /projects/:id/events` |
| Notifications | `GET /notifications`, read endpoints |
| Profiles | `GET /profiles` for PM/ADMIN profile search |
| Client invites | `GET /client-invites/me`, `POST /client-invites/accept` for CLIENT users |
| Orchestration bridge | `POST /projects/:id/orchestration/start`, status/gate endpoints, mock-provider work-order dispatch |

See `docs/architecture/production-readiness.md` for the role matrix, lifecycle rules, data-integrity rules, and verification baseline. See `docs/architecture/microservices-readiness.md` for the service boundary map, outbox event contracts, extraction order, and follow-up architecture recommendations.

Cross-repository architecture — how agents are stored and dispatched across the control plane, the
execution plane (`agentic-orchestration-ag`) and the console, and the human-action list — lives in
[docs/platform/](docs/platform/). It is versioned here because this repo is where those decisions
are enforced.

## Frontend Pairing

Run the frontend separately from `../agentic-orchestration-fe`:

```powershell
cd ..\agentic-orchestration-fe
Copy-Item .env.example .env.local
npm install
npm run dev
```

Use matching Supabase project values in both apps. The frontend only receives public values (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL`).

## Verification Baseline

```powershell
npm test
npm run build
npm run seed:demo
npm run seed:demo:check
npm run seed:demo:smoke
npm run smoke:openrouter  # skips when OPENROUTER_API_KEY is absent

cd ..\agentic-orchestration-fe
npm run typecheck
npm run build
```
