# Tribe Backend Template — NestJS

Reusable NestJS 11 backend template for ImplementSprint tribes. Each tribe clones this repository as their backend service. It comes pre-wired with Supabase, the API Center SDK, security middleware, CI/CD, and Docker — ready to extend with tribe-specific feature modules.

Start with `START_HERE_BACKEND.md` for a full onboarding and system-level explanation.

---

## What This Template Provides

- **Production-ready bootstrap** — Helmet, CORS, body size limits, graceful shutdown, global validation, structured error responses, and Swagger (toggled by env var).
- **Supabase integration** — pre-wired `SupabaseService` with connection health check.
- **API Center SDK** — pre-wired `ApiCenterSdkService` for calling the shared API gateway and registering this tribe's own APIs.
- **Correlation ID propagation** — every request gets an `X-Correlation-ID` header, linking tribe backend logs to API Center traces.
- **TypeScript strict mode** — `strict`, `noImplicitAny`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `module: nodenext`.
- **CI/CD pipeline** — caller workflow delegates to the central `master-pipeline-be.yml` orchestrator (test → uat → main promotion with quality gates, SonarCloud, k6, Docker build).
- **Non-root Docker container** — multi-stage Node 22 alpine build with a least-privilege `nestjs` user.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | NestJS 11 |
| Runtime | Node.js 22 LTS |
| Language | TypeScript 5 (strict mode) |
| Database | Supabase (PostgreSQL via `@supabase/supabase-js`) |
| API Gateway | ImplementSprint API Center (via internal SDK) |
| Testing | Jest + Supertest |
| Linting | ESLint + TypeScript ESLint + Prettier |
| CI/CD | GitHub Actions → central-workflow |
| Container | Docker multi-stage (node:22-alpine) |
| Code Quality | SonarCloud |
| Performance | Grafana k6 |

---

## Quick Start

```bash
cp .env.example .env
# Fill in your Supabase and API Center credentials in .env

npm install
npm run start:dev
```

Run quality checks:

```bash
npm run lint
npm run typecheck
npm run build
npm run test:cov
npm run test:e2e
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in real values. Never commit `.env`.

| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | Yes | `development` / `test` / `production` |
| `PORT` | Yes | HTTP port (default `3000`) |
| `ENABLE_SWAGGER` | No | Set `true` in dev to enable Swagger UI at `/api/v1/docs` |
| `SUPABASE_URL` | Conditional | Required for default client mode; optional when using scoped-only clients |
| `SUPABASE_ANON_KEY` | Conditional | Required for default client mode; optional when using scoped-only clients |
| `SUPABASE_SERVICE_ROLE_KEY` | Conditional | Required for default client mode; optional when using scoped-only clients |
| `<SERVICE>_SUPABASE_URL` | Optional | Service-scoped Supabase URL for multi-tribe/microservice access |
| `<SERVICE>_SUPABASE_SECRET_KEY` | Optional | Service-scoped Supabase service key (paired with `<SERVICE>_SUPABASE_URL`) |
| `<SERVICE>_SUPABASE_SERVICE_ROLE_KEY` | Optional | Alias for service-scoped secret key |
| `ALLOWED_ORIGINS` | Yes | Comma-separated CORS origins (e.g. `http://localhost:5173`) |
| `API_CENTER_BASE_URL` | Required in production | API Center gateway URL (alias accepted: `APICENTER_URL`) |
| `API_CENTER_TRIBE_ID` | Required in production (preferred) | APICenter auth mode: registered tribe/service id (alias accepted: `APICENTER_TRIBE_ID`) |
| `API_CENTER_TRIBE_SECRET` | Required in production (preferred) | Secret paired with `API_CENTER_TRIBE_ID` (alias accepted: `APICENTER_TRIBE_SECRET`) |
| `API_CENTER_API_KEY` | Optional (legacy fallback) | Legacy static bearer token mode |
| `API_CENTER_TIMEOUT_MS` | Optional | APICenter HTTP timeout in ms (default `10000`, alias accepted: `APICENTER_TIMEOUT_MS`) |

`SUPABASE_SERVICE_ROLE_KEY`, `API_CENTER_TRIBE_SECRET`, and `API_CENTER_API_KEY` are **HIGH sensitivity** — store them in GitHub Secrets or Vault, never in plaintext files committed to version control.

### Strict Env Validation

`libs/common/src/config/env.validation.ts` is enforced automatically when `NODE_ENV=production`, which makes production-grade deployments fail fast on missing required configuration. Non-production runs keep local developer flexibility.

---

## Project Structure

```text
apps/
  api/
    src/
      main.ts                       HTTP bootstrap: Helmet, CORS, validation, Swagger
      api.module.ts                 Root HTTP module
      api.controller.ts             GET /api/v1 -> { service, version }
      health/                       GET /api/v1/health
    Dockerfile
  location-service/
    src/
      main.ts                       TCP microservice bootstrap
      location-service.module.ts    Domain service module
      location/                     MessagePattern handlers
    Dockerfile
libs/
  api-center/                       Global TribeClient provider and registration service
  common/                           Config, security, filters, middleware, seed data
  contracts/                        Shared message patterns and payload contracts
  supabase/                         Supabase module/service
tests/
  e2e/                              Supertest e2e specs for the HTTP API
  performance/
    api-smoke.js                    k6 smoke test targeting /api/v1/health
    location-service-smoke.js       service smoke placeholder for deployed health URL
```

---

## Health Endpoint

```
GET /api/v1/health
```

Response when healthy:
```json
{
  "status": "ok",
  "uptimeSeconds": 42,
  "checks": {
    "database": true,
    "apiCenter": true
  }
}
```

| `status` | HTTP | Meaning |
|----------|------|---------|
| `ok` | 200 | Both Supabase and API Center are reachable |
| `degraded` | 200 | One dependency is unreachable — service is still running |
| `error` | 503 | Both dependencies are unreachable |

The Docker container healthcheck targets this endpoint.

---

## API Center SDK

The `ApiCenterSdkService` is the authorized channel for calling the shared API gateway. Any feature module can inject it:

- Preferred auth mode: `API_CENTER_TRIBE_ID` + `API_CENTER_TRIBE_SECRET` (short-lived token lifecycle)
- Legacy fallback mode: `API_CENTER_API_KEY` (deprecated static bearer token)
- Paths for APICenter namespaces (`/tribes`, `/shared`, `/external`, `/auth`, `/registry`, `/health`) are normalized to `/api/v1/...` automatically
- Typed Kafka helpers are available: `kafkaListClusters()`, `kafkaListTopics(clusterId)`, `kafkaProduceRecords(clusterId, topic, records)`, and `buildTenantTopic(tribeId, suffix)`

```typescript
constructor(private readonly sdkService: ApiCenterSdkService) {}

// Consume another tribe's registered API
const { data, correlationId } = await this.sdkService.get<User[]>('/tribes/tribe-b/users');

// Consume a shared external service registered in the API Center
const { data } = await this.sdkService.get('/shared/payment/invoice/123');

// Kafka through APICenter external routing
const topic = ApiCenterSdkService.buildTenantTopic('orders-service', 'order-created');
await this.sdkService.kafkaProduceRecords('lkc-123', topic, [
  {
    key: 'order-001',
    value: JSON.stringify({ orderId: 'order-001', status: 'created' }),
  },
]);
```

If `API_CENTER_BASE_URL` is not set, the service logs a warning at startup and all calls throw — it does not crash the application.

Service registration is available through `registerServiceManifest(...)` in `ApiCenterSdkService` for startup registration to `POST /api/v1/registry/register`.

---

## Supabase

The `SupabaseService` provides a pre-configured Supabase client using the service role key (bypasses RLS for server-side mutations). Inject it in any feature service:

```typescript
constructor(private readonly supabaseService: SupabaseService) {}

// Default client from SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
const client = this.supabaseService.getClient();
const { data, error } = await client.from('orders').select('*');

// Service-scoped client from PAYMENT_SERVICE_SUPABASE_URL + PAYMENT_SERVICE_SUPABASE_SECRET_KEY
const paymentClient = this.supabaseService.getClientForService('payment-service');
const { data: payments } = await paymentClient.from('invoices').select('*');
```

Service-scoped client naming convention:

- `PAYMENT_SERVICE_SUPABASE_URL` + `PAYMENT_SERVICE_SUPABASE_SECRET_KEY`
- `CHAT_SERVICE_SUPABASE_URL` + `CHAT_SERVICE_SUPABASE_SECRET_KEY`
- `PROVIDER_SERVICE_SUPABASE_URL` + `PROVIDER_SERVICE_SUPABASE_SECRET_KEY`

`SupabaseService` only activates scoped clients when both URL and secret exist for the same prefix.

Validation mode:

- Default mode: set all of `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- Scoped-only mode: omit default trio and set at least one `<SERVICE>_SUPABASE_URL` + `<SERVICE>_SUPABASE_SECRET_KEY` pair

Schema management is handled in the Supabase dashboard or via the Supabase CLI.

---

## CI/CD Pipeline

### Branch Flow

```
test → uat → main
```

Push to any of these branches to trigger the pipeline. Successful `test` builds automatically create a PR to `uat`. Successful `uat` builds create a PR to `main`, but only when all required quality gates pass.

### Required GitHub Repository Setup

Before the first pipeline run, configure these in your GitHub repository:

**Repository Variables:**

| Variable | Example Value | Purpose |
|----------|--------------|---------|
| `BACKEND_MULTI_SYSTEMS_JSON` | See below | Tells the pipeline to test/build each deployable app in this monorepo |

Example:

```json
[
  {
    "name": "my-api",
    "dir": ".",
    "install_dir": ".",
    "project": "api",
    "image": "ghcr.io/org/my-api",
    "backend_stack": "nestjs",
    "version_stream": "api",
    "test_command": "npm run test:cov -- --selectProjects api",
    "build_command": "npm run build:api",
    "dockerfile_path": "apps/api/Dockerfile",
    "k6_script_path": "tests/performance/api-smoke.js"
  },
  {
    "name": "my-location-service",
    "dir": ".",
    "install_dir": ".",
    "project": "location-service",
    "image": "ghcr.io/org/my-location-service",
    "backend_stack": "nestjs",
    "version_stream": "location-service",
    "test_command": "npm run test:cov -- --selectProjects location-service",
    "build_command": "npm run build:location-service",
    "dockerfile_path": "apps/location-service/Dockerfile",
    "k6_script_path": "tests/performance/location-service-smoke.js"
  }
]
```

**Repository Secrets:**

| Secret | Purpose |
|--------|---------|
| `SONAR_TOKEN` | SonarCloud authentication |
| `SONAR_ORGANIZATION` | SonarCloud organization slug |
| `SONAR_PROJECT_KEY` | Unique SonarCloud project key for this tribe |
| `GH_PR_TOKEN` | Token with PR write permissions for auto-promotion |
| `K6_CLOUD_TOKEN` | Grafana Cloud token for k6 execution |
| `K6_CLOUD_PROJECT_ID` | Grafana Cloud project ID for k6 execution |
| `RENDER_DEPLOY_HOOK_URL_TEST` | Required for `test` branch Render deployments |
| `RENDER_DEPLOY_HOOK_URL_UAT` | Required for `uat` branch Render deployments |
| `RENDER_DEPLOY_HOOK_URL_MAIN` | Required for `main` branch Render deployments |
| `RENDER_HEALTHCHECK_URL_TEST` | Required health URL for `test` branch verification |
| `RENDER_HEALTHCHECK_URL_UAT` | Required health URL for `uat` branch verification |
| `RENDER_HEALTHCHECK_URL_MAIN` | Required health URL for `main` branch verification |
| `RENDER_DEPLOY_HOOK_URL` | Optional fallback deploy hook URL if branch-specific secret is omitted |
| `RENDER_HEALTHCHECK_URL` | Optional fallback health URL if branch-specific secret is omitted |

### Pipeline Stages

1. **Quality gates** — lint, typecheck, build, unit tests (80% coverage threshold)
2. **Security scan** — `npm audit` + license compliance check
3. **SonarCloud** — static analysis (requires secrets above)
4. **Docker build** — multi-stage build + Trivy vulnerability scan (main branch only)
5. **Deploy lanes (central reusable pipeline)**
  - `deploy-preview` on `test`/`uat` (staging lane)
  - `render-deploy` on `test`/`uat`/`main` (deploy hook + health verification)
6. **k6 smoke test** — runs on configured branches after deploy lanes
7. **Versioning** — semantic version tag per branch
8. **Promotion** — auto-creates PR to next branch when required quality gates pass
  - branch mapping: `test` -> test, `uat` -> uat, `main` -> main
  - deployment passes only when health endpoint returns `checks.apiCenter=true`

---

## Render Deployment (Test/UAT/Main)

This template now uses Render for backend deployments through the central reusable backend pipeline.

### Deployment behavior

1. The caller workflow delegates deployment to `master-pipeline-be.yml` and keeps deploy lanes enabled on push.
2. The central `render-deploy` reusable lane runs on `test`, `uat`, and `main` branches.
3. The lane triggers the branch-specific Render deploy hook.
4. The lane polls the configured health endpoint and requires `checks.apiCenter=true` before passing.

### Setup

1. Create Render services/environments for `test`, `uat`, and `main` deployment targets.
2. Add deploy hooks in GitHub secrets:
  - `RENDER_DEPLOY_HOOK_URL_TEST`
  - `RENDER_DEPLOY_HOOK_URL_UAT`
  - `RENDER_DEPLOY_HOOK_URL_MAIN`
3. Add health URLs in GitHub secrets:
  - `RENDER_HEALTHCHECK_URL_TEST`
  - `RENDER_HEALTHCHECK_URL_UAT`
  - `RENDER_HEALTHCHECK_URL_MAIN`
4. Optional fallbacks:
  - `RENDER_DEPLOY_HOOK_URL`
  - `RENDER_HEALTHCHECK_URL`
5. Configure Render runtime environment variables (same set as `.env.example`).
  - Ensure APICenter values are present in production lanes so `checks.apiCenter=true` health validation passes.
6. Set APICenter auth mode:
  - Preferred: `API_CENTER_TRIBE_ID` + `API_CENTER_TRIBE_SECRET`
  - Legacy fallback only: `API_CENTER_API_KEY`
7. Set `NODE_ENV=production` and `ENABLE_SWAGGER=false` in Render.

> **CORS note:** The CORS factory uses exact-match whitelisting. Set `ALLOWED_ORIGINS` to your exact frontend URLs for each environment.

---

## Docker

Build and run locally:

```bash
docker build -t tribe-backend .
docker run --rm -p 3000:3000 --env-file .env tribe-backend
```

The container:
- Uses `node:22-alpine` for both build and runtime stages
- Runs as a non-root `nestjs` user (UID 1001)
- Health-checks `http://127.0.0.1:3000/api/v1/health` every 30 seconds
- Excludes `tests/`, `test/`, `.git`, `.env` from the build context

---

## Strict TypeScript Policy

| Flag | Value |
|------|-------|
| `strict` | `true` |
| `allowJs` | `false` |
| `noImplicitAny` | `true` |
| `noUncheckedIndexedAccess` | `true` |
| `exactOptionalPropertyTypes` | `true` |
| `module` | `nodenext` |
| `moduleResolution` | `nodenext` |

All new feature modules must pass `npm run typecheck` with zero errors. Use type-only imports (`import type`) where no runtime value is needed.

---

## Integrating Into an Existing Tribe Backend

If your tribe already has a NestJS backend, migrate toward this workspace shape:

1. **Adopt the workspace layout** - keep deployable runtimes under `apps/*` and shared modules under `libs/*`.
2. **Copy the shared libraries** - `libs/common`, `libs/api-center`, `libs/supabase`, and `libs/contracts`.
3. **Wire HTTP modules through `apps/api/src/api.module.ts`** - import shared modules and any tribe domain modules needed by the API.
4. **Add new microservices under `apps/<domain>-service`** - expose message contracts from `libs/contracts`.
5. **Replace the CI caller** - use `.github/workflows/be-pipeline-caller.yml` from this template.
6. **Configure GitHub** - set `BACKEND_MULTI_SYSTEMS_JSON`, GitHub Packages access, and the repository secrets listed above.
7. **Set runtime env** - Supabase credentials, API Center URL, tribe credentials, CORS origins, and per-service ports.
