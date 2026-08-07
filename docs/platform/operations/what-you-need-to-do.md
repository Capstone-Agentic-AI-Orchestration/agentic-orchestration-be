# What you need to do

Status: active. Actions that require a human — credentials, production deploys, or a decision.

Everything else in the roadmap is code and lands without you. This page is only the things an
agent cannot or should not do on its own. Ordered by impact.

---

## 1. Redeploy the agent package — **blocking, breaks 4 agents today**

Four subagents fail on every run right now: `qa`, `security-review`, `integration-reviewer`,
`planner-orchestrator`. The code is committed and pushed; the deployment is stale.

**Do this:** Vercel dashboard → the `agentic-orchestration-ag` project → **Redeploy**.

Full runbook, alternatives, and how to diagnose why it went stale:
[agent-package-redeploy.md](agent-package-redeploy.md)

**How you'll know it worked:** those four agents stop showing a red **No runtime** badge on
`/pm/agents`. No need to read a manifest — the console checks for you.

**Cost:** none. Existing project, no new infrastructure, and the model
(`inclusionai/ling-3.0-flash-free`) is a free tier reached by Vercel OIDC with no API key.

---

## 2. Restart the backend — **1 minute, may already be costing you quality**

`EveLlmProvider.isConfigured()` reads `process.env.EVE_SERVICE_URL` at call time. A backend
process started before that line was added to `.env` reports Eve as unconfigured and **silently
falls back to the direct provider**, which has no tools and no typecheck self-repair loop.

That fallback is invisible except for a console banner reading "Eve service is not configured".
If you have seen that banner, agents have been generating code nobody compiled.

```bash
# in the agentic-orchestration-be terminal: stop, then
npm run dev
```

Confirm the banner is gone on a project page.

---

## 3. Decide: fix `.env.example` so it stops recommending a paid model

`agentic-orchestration-ag/.env.example` ships:

```
EVE_MODEL="openai/gpt-5.4-mini"
```

Your live config uses `inclusionai/ling-3.0-flash-free`. Anyone setting up from the example lands
on a paid model by default — the opposite of the intent.

**Decision needed:** should the example match the free default? Say so and it is a one-line
change.

---

## 4. Optional: `npm install` in the agent package

`package.json` requires `eve@^0.27.6`; `node_modules` has **0.13.8**, which does not satisfy it.

This does **not** affect the deployment — Vercel installs from `package.json` during its own
build. It only affects local `eve dev` and `npm run typecheck`, which currently run against a
version two majors behind production.

```bash
cd agentic-orchestration-ag && npm install
```

Safe for an agent to run on request; left here because it changes `package-lock.json`.

---

## Later, when the relevant roadmap step is reached

These are not needed yet. Listed so they are not a surprise.

| Trigger | Action | Why a human |
|---|---|---|
| Roadmap step 5 lands | Deploy the package again, for the dynamic skill resolver | production deploy |
| Any schema step lands | `npx prisma migrate deploy` in `agentic-orchestration-be` | writes to production Postgres |

Migrations so far have been applied. `prisma migrate status` reports the current state at any
time and is read-only.

**Note on the client workspace migration:** `20260807000700_client_requires_workspace` has been
applied. It aborts rather than damaging data if any client still has no workspace, so it is safe
to re-run. The one orphan (Alpha) was assigned to **ShotiPogi** along with its project — change
it from the client page (Overview → Details → Workspace) if that is wrong.

**Note on step 1:** the redeploy now covers two things, not one. It deploys the four missing
subagents *and* the two new role-neutral runtimes (`generic-builder`, `generic-reviewer`) that
roadmap step 4 added. Until it runs, creating a custom agent works and the agent correctly shows
**No runtime**, because the capability it borrows is not live yet.

---

## Standing constraints an agent should not change alone

- **Model choice.** The default is free. Selecting a paid model in the run wizard is the point at
  which spending starts, and the catalog is fetched live from the Vercel AI Gateway, which lists
  paid models alongside free ones. Nothing in the UI currently marks which is which.
- **Production deploys.** Vercel and Prisma deploys are outward-facing and are left to you unless
  you say otherwise for a specific change.
