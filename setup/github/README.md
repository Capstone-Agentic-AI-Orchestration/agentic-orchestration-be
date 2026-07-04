# GitHub setup — Capstone-Agentic-AI-Orchestration

Provisions GitHub identities for three environments — **test**, **uat**, **main** —
each getting a **GitHub App** and an **OAuth App**, both named
`agentic-orchestration-<env>`.

The two are different things and their credentials live in different places:

| | GitHub App (`agentic-orchestration-<env>`) | OAuth App (`agentic-orchestration-<env>`) |
|---|---|---|
| Purpose | Server-to-server: the backend pushing code artifacts to repos | User login "Sign in with GitHub" |
| Identity | Acts as itself (installation token) | Acts on behalf of a user |
| Creation | **Automated** via the manifest flow below | **Manual** — GitHub has no OAuth-App creation API |
| Credentials go into | **Render** env vars (this backend's `.env`) | **Supabase** dashboard (Auth → Providers → GitHub) |
| Callback URL | `<apiUrl>/github/webhooks` (webhook, currently inactive) | `https://<supabaseRef>.supabase.co/auth/v1/callback` |

> Why the split? This backend verifies **Supabase-issued JWTs**
> (`src/auth/supabase-auth.guard.ts`), so Supabase is your identity provider.
> GitHub login therefore runs through Supabase's GitHub provider — the OAuth App
> credentials belong in Supabase, and the backend needs no OAuth code.

---

## 0. Prerequisites

1. You're an **org admin** of `Capstone-Agentic-AI-Orchestration` (you are).
2. Fill in **[`environments.json`](./environments.json)** — for each env set:
   - `frontendUrl` — the Vercel URL (App homepage)
   - `apiUrl` — the Render service URL (GitHub App webhook host)
   - `supabaseRef` — the Supabase project ref for that env (`xxxx` in `https://xxxx.supabase.co`)

---

## 1. GitHub Apps (automated — run 3×)

For each environment:

```bash
cd agentic-orchestration-be/setup/github

# 1) Create the app — opens a browser; click "Create GitHub App".
node create-github-app.mjs create test

# 2) Install it on the org via the link the script prints, then:
node create-github-app.mjs installation test
```

Repeat for `uat` and `main`. Each run writes
`credentials/<env>.env` (gitignored) containing:

```
GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET,
GITHUB_WEBHOOK_SECRET, GITHUB_PRIVATE_KEY (base64 PEM), GITHUB_INSTALLATION_ID
```

Copy those into the matching Render service's environment variables. The backend
already reads `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`,
`GITHUB_ORG` (see `.env.example`).

**Default permissions** requested: `contents:write`, `metadata:read`,
`pull_requests:write`, `workflows:write`. Adjust in
`create-github-app.mjs → buildManifest()` before creating, or on the app page after.

> Note: GitHub App names are globally unique. If `agentic-orchestration-main` is
> already taken, rename on the GitHub confirmation screen.
>
> Your existing app **3899575** can serve as `main` if you prefer (see the
> "reuse" option) — but you chose 3 fresh apps, so it can be retired afterward.

---

## 2. OAuth Apps (manual — do 3×)

There is no API for OAuth Apps. For each environment, go to:

`https://github.com/organizations/Capstone-Agentic-AI-Orchestration/settings/applications/new`

Enter:

| Field | Value |
|---|---|
| Application name | `agentic-orchestration-<env>` |
| Homepage URL | `<frontendUrl>` for that env |
| Authorization callback URL | `https://<supabaseRef>.supabase.co/auth/v1/callback` |

Then **Register application → Generate a new client secret**, and copy the
**Client ID** + **Client secret** into that environment's **Supabase** project:

`Supabase → Authentication → Providers → GitHub → enable → paste Client ID/Secret → Save`

Also set, per Supabase project:
`Authentication → URL Configuration → Site URL = <frontendUrl>` and add it to the
redirect allow-list.

The frontend then triggers login with
`supabase.auth.signInWithOAuth({ provider: 'github' })` — no backend change needed.

---

## Summary — 6 registrations

| Env | GitHub App | OAuth App | App creds → | OAuth creds → |
|-----|-----------|-----------|-------------|---------------|
| test | agentic-orchestration-test | agentic-orchestration-test | Render (test) | Supabase (test) |
| uat  | agentic-orchestration-uat  | agentic-orchestration-uat  | Render (uat)  | Supabase (uat)  |
| main | agentic-orchestration-main | agentic-orchestration-main | Render (main) | Supabase (main) |
