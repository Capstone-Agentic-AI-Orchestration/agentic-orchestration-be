# Runbook: redeploy the agent package

Status: active. Applies to `agentic-orchestration-ag`.

## Symptom

Runs fail inside contract negotiation, QA review, security review or integration review, with an
error of the form:

```
Eve session for 'qa' failed (…)
Eve subagent 'qa' returned an empty response.
```

Or, in the console, one or more agents on `/pm/agents` show a red **No runtime** badge.

## Cause

The deployed Eve service is running an older build than `main`. The subagent directories exist in
the repository but not in the deployment.

Verified state at the time of writing:

| | Count | Detail |
|---|---|---|
| Repository | 12 | all tracked, committed in `c83fc52` (2026-07-27) |
| `origin/main` | 12 | `c83fc52`, 0 commits ahead locally |
| **Deployed** | **8** | missing `qa`, `security-review`, `integration-reviewer`, `planner-orchestrator` |

## Fix

Pick whichever applies. The first is simplest and has no prerequisites.

### A. Vercel dashboard (recommended)

Open the `agentic-orchestration-ag` project → **Deployments** → most recent → **Redeploy**.

Leave "use existing build cache" **off** so the new subagent directories are picked up by
discovery.

### B. Trigger a git deploy

Only if the Vercel project is connected to the GitHub repository:

```bash
cd agentic-orchestration-ag
git commit --allow-empty -m "chore: redeploy agent package"
git push
```

### C. Vercel CLI

Requires linking the folder and being scoped to the team that owns the project.

```bash
cd agentic-orchestration-ag
npx vercel link      # interactive
npx eve deploy
```

At the time of writing `npx vercel whoami` returns `lloydlim1` but
`npx vercel project ls` returns **`Not authorized`** — the session is not scoped to the
`Capstone-Agentic-AI-Orchestration` team that owns the repository. Resolve that first, or use
option A.

## Verify

Easiest — the console does it for you: reload `/pm/agents`. The **No runtime** badges should be
gone. That badge is driven by the same manifest this runbook is about.

Directly, if you want the raw list:

```bash
cd agentic-orchestration-be
TOKEN=$(grep '^EVE_SERVICE_TOKEN' .env | cut -d'"' -f2)
curl -s -H "Authorization: Bearer $TOKEN" \
  https://agentic-orchestration-ag.vercel.app/eve/v1/info \
  | python -c "import json,sys; print(sorted(s['name'] for s in json.load(sys.stdin)['subagents']['local']))"
```

Expect all twelve:

```
architecture, backend, contract-negotiator, database, frontend, integration-reviewer,
mobile, planner-orchestrator, qa, requirements-parser, security-review, self-critique
```

The control plane caches the manifest for 60 seconds, so the badges clear within a minute.

## Then find out why it went stale

A redeploy fixes the symptom. If the project is git-connected, a push on 27 July should have
deployed on its own, so one of these is true:

- the Vercel project is **not** connected to the repository, and deploys have been manual
- a build **failed** after that commit and nobody was notified

Check the project's Deployments tab for a failed build dated on or after 2026-07-27, and its
Git settings for a connected repository. Fixing the connection is what stops this recurring.

## Cost

None beyond what already runs. The project is already deployed and serving; this rebuilds it.
The model is `inclusionai/ling-3.0-flash-free`, a free tier reached through the Vercel AI Gateway
with OIDC — the backend holds no provider API key.

Token usage per run **will rise**, because four agents that currently fail immediately will start
doing real work. On the free model that is still no spend, and those four failing is why review
and contract negotiation are not happening today.
