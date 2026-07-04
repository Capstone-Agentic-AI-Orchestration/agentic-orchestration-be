# GitHub OAuth, Render, Vercel, and CI/CD Setup

DevFlow uses Supabase Auth as the identity broker. GitHub OAuth is configured in GitHub and Supabase, the browser receives a Supabase session, and the backend verifies the Supabase access token before applying DevFlow roles from the `profiles` table.

For this rollout, every app role (`CLIENT`, `PM`, `DEV`, and `ADMIN`) signs in through GitHub OAuth. Google can be enabled later by adding the Google provider in Supabase and changing `AUTH_ALLOWED_PROVIDERS` from `github` to `github,google`.

This repository is also wired into the central CI/CD flow. Treat OAuth redirect URLs, Render services, Vercel environments, and GitHub Actions secrets as one setup, because the `test`, `uat`, and `main` branches create real deployed targets.

## 1. Branch and environment map

Use this map before creating OAuth redirect URLs or deployment secrets.

| Branch | Purpose | Frontend target | Backend target | Notes |
| --- | --- | --- | --- | --- |
| `develop` | Backend integration checks | Optional | Optional | The backend caller runs on `develop`, but the frontend caller does not. Use it as CI-only unless the team chooses a dev deployment. |
| `test` | CI preview and first promotion gate | Vercel preview | Render test service | Frontend Playwright and k6 default to `test`. A successful push can prepare promotion to `uat`. |
| `uat` | Pre-production validation | Vercel preview or UAT alias | Render UAT service | Use this for stakeholder testing. Frontend Playwright and k6 also default to `uat`. |
| `main` | Production | Vercel production | Render production service | Production OAuth redirects and CORS must be configured before merging here. |

Recommended service names:

```text
devflow-backend-test
devflow-backend-uat
devflow-backend-prod
devflow-frontend
```

## 2. Create the GitHub OAuth app

1. In GitHub, open Developer settings, then OAuth Apps.
2. Create a new OAuth app.
3. Set Homepage URL to the production frontend URL, for example `https://devflow.example.com`.
4. Set Authorization callback URL to the Supabase callback URL:

```text
https://<your-supabase-project-ref>.supabase.co/auth/v1/callback
```

5. Copy the GitHub Client ID and Client Secret.

Only Supabase needs the GitHub OAuth Client Secret for this flow. Do not put that secret in Render, Vercel, or GitHub Actions.

## 3. Enable GitHub in Supabase

1. In Supabase, open Authentication, then Providers.
2. Enable GitHub.
3. Paste the GitHub OAuth Client ID and Client Secret.
4. In Authentication URL Configuration, set Site URL to the production frontend URL.
5. Add redirect URLs for local, preview, UAT, and production:

```text
http://localhost:3000/client/sign-in
https://<production-domain>/client/sign-in
https://<vercel-production-app>.vercel.app/client/sign-in
https://*-<vercel-team-or-scope>.vercel.app/client/sign-in
https://<vercel-project>-git-*.vercel.app/client/sign-in
https://uat.<domain>/client/sign-in
https://test.<domain>/client/sign-in
```

Use the wildcard pattern that matches the actual Vercel preview URLs for this project. If the team does not create custom `test` or `uat` aliases, omit those alias lines and rely on the Vercel preview wildcard.

If Vercel Deployment Protection is enabled, preview smoke checks can receive `401` or `403`. The existing frontend k6 smoke allows `200`, `401`, and `403` for Vercel preview URLs, but real OAuth and Playwright sign-in tests need either an unprotected UAT URL or the team's approved Vercel bypass setup.

## 4. Configure Render backend services

Create separate Render Web Services for `test`, `uat`, and `main`, or create one service per environment in the team's Render workspace.

Recommended commands:

```bash
Build Command: npm ci --ignore-scripts && npm run prisma:generate && npm run build
Start Command: npm run prisma:migrate && npm run start
Health Check Path: /health
```

Set these Render environment variables on each backend service:

```env
NODE_ENV=production
PORT=10000
DATABASE_URL=postgresql://...
SUPABASE_URL=https://your-project-ref.supabase.co
AUTH_ALLOWED_PROVIDERS=github
CORS_ORIGIN=https://your-frontend-origin.example.com
AGENT_PROVIDER=mock
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY=
GITHUB_INSTALLATION_ID=
GITHUB_ORG=
LANGCHAIN_TRACING_V2=false
LANGCHAIN_PROJECT=devflow
OUTBOX_RELAY_ENABLED=false
```

Set `CORS_ORIGIN` to the exact frontend origin for that environment:

| Render service | `CORS_ORIGIN` example |
| --- | --- |
| `devflow-backend-test` | `https://<test-preview-or-alias>` |
| `devflow-backend-uat` | `https://<uat-preview-or-alias>` |
| `devflow-backend-prod` | `https://<production-domain>` |

The current backend reads `CORS_ORIGIN` as one value. If the team needs to allow many Vercel preview URLs at once, either use stable `test` and `uat` aliases or update the backend CORS setup to parse an allow-list.

## 5. Configure Vercel frontend environments

Create a Vercel project for `devflow-frontend`.

Set these variables in Vercel. Use Vercel's environment scopes so Preview points to the test/UAT backend and Production points to the production backend.

Preview:

```env
NEXT_PUBLIC_API_URL=https://devflow-backend-test.onrender.com
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-publishable-or-anon-key
NEXT_PUBLIC_AUTH_REDIRECT_PATH=/client/sign-in
```

Production:

```env
NEXT_PUBLIC_API_URL=https://devflow-backend-prod.onrender.com
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-publishable-or-anon-key
NEXT_PUBLIC_AUTH_REDIRECT_PATH=/client/sign-in
```

Only `NEXT_PUBLIC_*` browser-safe values belong in Vercel for this frontend. Do not add `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, GitHub App private keys, LLM provider keys, or GitHub OAuth Client Secret to the frontend.

If `test` and `uat` must point to different backend services, create stable Vercel aliases for each branch or split the frontend into environment-specific projects. A single Vercel Preview variable scope applies to preview deployments generally.

## 6. Configure GitHub Actions variables and secrets

The backend caller uses:

```text
Capstone-Agentic-AI-Orchestration/central-workflow/.github/workflows/master-pipeline-be.yml@main
```

It runs on pushes to `develop`, `test`, `uat`, and `main`. On pushes, deploy and promotion lanes are enabled.

Add these backend deployment secrets to the `devflow-backend` GitHub repository:

```text
RENDER_DEPLOY_HOOK_URL_TEST
RENDER_DEPLOY_HOOK_URL_UAT
RENDER_DEPLOY_HOOK_URL_MAIN
RENDER_HEALTHCHECK_URL_TEST
RENDER_HEALTHCHECK_URL_UAT
RENDER_HEALTHCHECK_URL_MAIN
GH_PR_TOKEN
```

Optional quality and notification secrets:

```text
SONAR_TOKEN
SONAR_ORGANIZATION
SONAR_PROJECT_KEY
K6_CLOUD_TOKEN
K6_CLOUD_PROJECT_ID
SLACK_WEBHOOK_URL
DISCORD_WEBHOOK_URL
```

The frontend caller uses:

```text
Capstone-Agentic-AI-Orchestration/central-workflow/.github/workflows/master-pipeline-fe.yml@main
```

It runs on pushes and pull requests targeting `test`, `uat`, and `main`. Add these to the `devflow-frontend` GitHub repository:

Repository variable name:

```text
FE_SINGLE_SYSTEMS_JSON
```

Repository variable value:

```json
[
  {
    "name": "devflow-frontend",
    "dir": ".",
    "image": "devflow-frontend",
    "vercel_project_secret": "VERCEL_PROJECT_ID_DEVFLOW_FRONTEND"
  }
]
```

Repository secrets:

```text
VERCEL_TOKEN
VERCEL_ORG_ID
VERCEL_PROJECT_ID_DEVFLOW_FRONTEND
GH_PR_TOKEN
```

Optional quality and notification secrets:

```text
SONAR_TOKEN
SONAR_ORGANIZATION
SONAR_PROJECT_KEY
K6_CLOUD_TOKEN
K6_CLOUD_PROJECT_ID
SLACK_WEBHOOK_URL
DISCORD_WEBHOOK_URL
```

`GH_PR_TOKEN` is used for auto-promotion pull requests and Vercel deployment comments. It should have permission to create pull requests in the repository.

## 7. CI/CD promotion flow

Use this flow when validating OAuth changes:

1. Work locally and verify GitHub login at `http://localhost:3000/client/sign-in`.
2. Merge or push into `test`.
3. Confirm the `test` deployment can open the sign-in page and complete GitHub OAuth.
4. Let the promotion PR move `test` to `uat`, or create the PR manually if automation is disabled.
5. Confirm the UAT deployment can complete GitHub OAuth.
6. Promote `uat` to `main`.
7. Confirm production login and backend authenticated routes.

Keep the promotion automation. The central workflow is designed to create promotion PRs after successful gates, so CI/CD should fail loudly when required secrets or deploy URLs are missing instead of silently skipping the release path.

## 8. CI smoke checks and auth boundaries

Backend k6 currently checks:

```text
GET /health
```

Keep `/health` public so Render health checks and backend k6 smoke tests can pass without a Supabase bearer token.

Frontend k6 checks the deployed frontend URL. For Vercel preview URLs it accepts `200`, `401`, and `403` because deployment protection can block anonymous smoke traffic. For true end-to-end auth tests, configure an accessible UAT URL or a Vercel bypass method approved by the team.

If future smoke tests hit authenticated API routes, pass a valid Supabase access token through GitHub Actions secrets and add it as an `Authorization: Bearer <token>` header in the test script.

## 9. Role setup

The first GitHub login creates a `CLIENT` profile by default. To promote a user:

```powershell
cd devflow-backend
npm run auth:set-role -- --email user@example.com --role PM
npm run auth:set-role -- --email dev@example.com --role DEV
npm run auth:set-role -- --email admin@example.com --role ADMIN
```

Valid roles are `CLIENT`, `PM`, `DEV`, and `ADMIN`.

## 10. Local smoke path

Backend:

```powershell
cd devflow-backend
Copy-Item .env.example .env
npm install
npm run prisma:generate
npm run build
npm run start
```

Frontend:

```powershell
cd ..\devflow-frontend
Copy-Item .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000/client/sign-in` and use the GitHub button.
