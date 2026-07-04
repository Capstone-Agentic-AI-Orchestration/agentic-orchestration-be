# START_HERE_BACKEND

This repository is the NestJS monorepo backend template for tribe services.

## 1) What This Repository Is

It contains two deployable runtimes and shared libraries:

```text
apps/api                 HTTP API runtime
apps/location-service    starter TCP microservice runtime
libs/api-center          APICenter TribeClient provider and auto-registration
libs/common              config, security, filters, middleware, seed data
libs/contracts           shared microservice message patterns and DTO contracts
libs/supabase            Supabase module and health helpers
```

The API and microservice are separate Nest projects in one workspace. They can be built and deployed independently while sharing contracts and providers.

## 2) Day-0 GitHub Setup

Set `BACKEND_MULTI_SYSTEMS_JSON` in repository variables. Example:

```json
[
  {
    "name": "my-api",
    "dir": ".",
    "install_dir": ".",
    "project": "api",
    "image": "ghcr.io/implementsprint/my-api",
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
    "image": "ghcr.io/implementsprint/my-location-service",
    "backend_stack": "nestjs",
    "version_stream": "location-service",
    "test_command": "npm run test:cov -- --selectProjects location-service",
    "build_command": "npm run build:location-service",
    "dockerfile_path": "apps/location-service/Dockerfile",
    "k6_script_path": "tests/performance/location-service-smoke.js"
  }
]
```

Do not use `BACKEND_SINGLE_SYSTEMS_JSON` for this template.

## 3) SDK Install Setup

The runtime SDK is `@implementsprint/sdk` from GitHub Packages. The committed `.npmrc` uses:

```text
@implementsprint:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

GitHub Actions supplies `GITHUB_TOKEN` during installs. Local developers need a shell-level `GITHUB_TOKEN` only when running a clean `npm ci` against GitHub Packages.

Runtime APICenter access still uses `API_CENTER_BASE_URL`, `API_CENTER_TRIBE_ID`, and `API_CENTER_TRIBE_SECRET`. Package install auth and runtime gateway auth are separate.

## 4) Runtime Env

Required in production:

- `NODE_ENV=production`
- `PORT`
- `ALLOWED_ORIGINS`
- `API_CENTER_BASE_URL` or `APICENTER_URL`
- `API_CENTER_TRIBE_ID` or `APICENTER_TRIBE_ID`
- `API_CENTER_TRIBE_SECRET` or `APICENTER_TRIBE_SECRET`

Supabase can use the default `SUPABASE_URL` plus `SUPABASE_SERVICE_ROLE_KEY`, or service-scoped pairs such as `PAYMENT_SERVICE_SUPABASE_URL` plus `PAYMENT_SERVICE_SUPABASE_SECRET_KEY`.

## 5) Development Commands

```bash
npm install
npm run start:dev
npm run start:location-service:dev
npm run lint
npm run typecheck
npm run build
npm run test:cov
npm run test:e2e
```

On Windows, if Jest worker spawning is blocked locally, use:

```bash
npm run test:cov -- --runInBand
npm run test:e2e -- --runInBand
```

## 6) Adding Tribe Features

- Put HTTP-facing controllers and API composition under `apps/api/src`.
- Put independently deployable domain workers under `apps/<domain>-service`.
- Put cross-app DTOs, message patterns, and event names under `libs/contracts`.
- Put shared APICenter access under `libs/api-center`.
- Put shared Supabase access under `libs/supabase`.

New microservices should get their own Dockerfile, test selector, image name, and `BACKEND_MULTI_SYSTEMS_JSON` entry.

## 7) Common Mistakes To Avoid

- Reintroducing a root `src/` app as the primary runtime.
- Using `BACKEND_SINGLE_SYSTEMS_JSON` for this monorepo.
- Copying SDK wrapper code instead of injecting `TribeClient` from `libs/api-center`.
- Putting `APICENTER_TRIBE_SECRET` in frontend code.
- Calling shared services directly instead of going through APICenter.
