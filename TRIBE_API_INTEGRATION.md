# Tribe API Integration Guide

This backend consumes APICenter through the GitHub Packages SDK `@implementsprint/sdk`.

## Install Contract

The repo commits a safe `.npmrc` placeholder:

```text
@implementsprint:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

GitHub Actions provides `GITHUB_TOKEN` for dependency installation. Do not commit a literal token.

## Runtime Contract

Set these runtime variables in Render, your cluster secret store, or local `.env`:

- `API_CENTER_BASE_URL`
- `API_CENTER_TRIBE_ID`
- `API_CENTER_TRIBE_SECRET`

Aliases `APICENTER_URL`, `APICENTER_TRIBE_ID`, and `APICENTER_TRIBE_SECRET` are also accepted.

## NestJS Placement

The APICenter provider lives in:

```text
libs/api-center/src/api-center-sdk.module.ts
libs/api-center/src/tribe-registration.service.ts
```

`ApiCenterSdkModule` is global, so feature services can inject `TribeClient` directly.

```typescript
import { Injectable } from '@nestjs/common';
import { TribeClient } from '@implementsprint/sdk';

@Injectable()
export class MyTribeFeatureService {
  constructor(private readonly tribeClient: TribeClient) {}

  async sendSharedEmail() {
    return this.tribeClient.emailSend({
      to: 'user@example.com',
      subject: 'Welcome',
      body: 'Hello from the tribe backend.'
    });
  }
}
```

For a new microservice app, place message contracts in `libs/contracts` and import `ApiCenterSdkModule` into the app module.

## Service Exposure

Keep tribe-owned service metadata in `tribe-manifest.json`:

- `serviceId`
- `name`
- `baseUrl`
- `exposes`
- `consumes`
- `requiredScopes`
- `serviceType`

The auto-registration service posts this manifest to APICenter when `API_CENTER_BASE_URL` is configured.
