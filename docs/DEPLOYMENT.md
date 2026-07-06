# DevFlow Deployment

Topology after the Eve migration:

```
Frontend (Vercel)  ──socket.io/REST──►  NestJS backend (Render)  ──HTTPS──►  Eve agent (Vercel)
                                              │
                                              └──►  Postgres / pgvector (Supabase)
```

The frontend only talks to the backend. The Eve agent is server-to-server only (the backend calls
it; never the browser). See `docs/architecture/EVE_MIGRATION.md` for the architecture rationale.

## Engines

`ORCHESTRATION_LLM_ENGINE` selects generation:
- `eve` (default) — delegate each agent turn to the Eve service (sandbox typecheck + self-repair).
- `direct` — in-process raw-fetch provider (`DirectLlmProvider`) using `LLM_PROVIDER`.
- `graph` — deprecated alias for `direct`, accepted for one release.

`AgentLlmRouter` falls back to `direct` automatically when `EVE_SERVICE_URL` is unset/unreachable,
so the backend runs fine **before** the Eve service exists. Roll out on `direct`, then flip to `eve`.

## One-time backend prep

```bash
cd devflow-backend
npm install                 # lockfile already free of @langchain/*; pulls openai (embeddings)
npx prisma generate
npx prisma migrate deploy   # applies 20260625120000_add_orchestration_checkpoint_state
npm run build
```

## Render (NestJS backend) env

| Var | Value | Notes |
|---|---|---|
| `DATABASE_URL` | Postgres connection | existing |
| `AGENT_PROVIDER` | `llm` | `mock`/`simulation` skip the real code-gen pipeline |
| `ORCHESTRATION_LLM_ENGINE` | `eve` | or `direct` to stay in-process |
| `EVE_SERVICE_URL` | `https://<eve>.vercel.app` | required to actually use Eve; empty ⇒ direct fallback |
| `EVE_SERVICE_TOKEN` | shared secret | must match the Eve route-auth secret |
| `OPENROUTER_API_KEY` (or provider key) | … | used by the `direct` engine + fallback |
| `OPENAI_API_KEY` | … | required for pgvector embeddings (`EmbeddingService`) |
| `CORS_ORIGIN` | frontend Vercel domain | |

## Eve agent (Vercel) — only when going to the `eve` engine

```bash
cd devflow-eve-agent
npm install
npx eve dev          # validate the SDK surface + subagents locally first
vercel deploy
```

Eve (Vercel) env: the route-auth secret (= `EVE_SERVICE_TOKEN`), `EVE_MODEL` (AI Gateway model
string) or direct provider keys.

> Eve is a public beta. Run `npx eve dev` and confirm the `defineAgent`/`defineTool` API and the
> `/eve/v1/session` request + SSE shape match `src/orchestration/providers/eve-llm.provider.ts`
> before relying on it. The thin `EveLlmProvider` boundary is intentional so the contract is easy
> to adjust.

## Rollout order

1. Deploy backend on `direct` (no Eve needed) → verify a full run end-to-end.
2. Deploy the Eve agent to Vercel; set `EVE_SERVICE_URL` + `EVE_SERVICE_TOKEN` on Render.
3. Flip `ORCHESTRATION_LLM_ENGINE=eve`; verify a run routes to Eve (check the Vercel Agent Runs).
4. Rollback at any time: unset `EVE_SERVICE_URL` or set `ORCHESTRATION_LLM_ENGINE=direct`.

## Smoke check (direct engine, local)

```bash
AGENT_PROVIDER=llm ORCHESTRATION_LLM_ENGINE=direct OPENROUTER_API_KEY=... npm run start
# create a project via the API and watch the run reach AWAITING_GATE_1
```

OpenCode-only direct mode:

```bash
AGENT_PROVIDER=llm ORCHESTRATION_LLM_ENGINE=direct LLM_PROVIDER=opencode OPENCODE_API_KEY=... npm run start
```
