# LangChain/LangGraph → Vercel Eve Migration

> Status: **LangChain/LangGraph fully removed; Eve is the canonical generation engine.** The
> LangGraph engine is replaced by an in-process `OrchestrationSequencer`. Agent **cognition**
> (generate → sandbox typecheck → self-repair) lives in Eve subagents; NestJS-on-Render remains
> the **control plane** (sequencing, gates, run state, memory retrieval, validation, persistence,
> streaming, GitHub delivery). `ORCHESTRATION_LLM_ENGINE` defaults to `eve` and auto-falls-back to
> the in-process `graph` provider when `EVE_SERVICE_URL` is unset/unreachable.
> Remaining external steps (not code): deploy the Eve service, run the DB migration for
> `OrchestrationRun.checkpointState`, and `npm install` to drop `@langchain/*` from the lockfile.
> Branch: `langchain-eve`. Strategy: **Full Eve agents + NestJS/Render control plane.**
> Last updated: 2026-06-24.

## Architecture decisions (locked)

| Decision | Choice | Consequence |
|---|---|---|
| Where agents live | **Eve owns cognition** (generate + sandbox `typecheck` + self-repair per subagent); NestJS keeps orchestration | Each Eve subagent is a complete agent; nodes are control-plane adapters |
| Memory / RAG | **NestJS retrieves (pgvector) and passes context into the Eve message** | pgvector stays in one place; Eve needs no DB access; generation spec + memory travel in the turn message |
| Canonical engine | **`eve` default**, `graph` automatic fallback | Safe before the Eve service exists; flip-proof |
| Validation | **Eve self-checks in sandbox + NestJS `output-validation` is authoritative** | Belt-and-suspenders; control plane independently verifies what it commits |
| Prompt source of truth | **`agent-prompts.ts`** (built into the turn message by the node, used by *both* engines); `instructions.md` owns only the Eve loop behavior | No prompt duplication — the generation spec has one home |

Hosting is unchanged: NestJS on Render, Eve as a separate Vercel service, talking over HTTP.

## 0. Implementation status (what's in the code now)

| Area | Done |
|---|---|
| LangGraph `StateGraph` → `OrchestrationSequencer` (phases A/B/C, gates, retry loop, abort, parallel fan-out) | ✅ [orchestration-sequencer.ts](../../src/orchestration/graph/orchestration-sequencer.ts) |
| `Annotation` state → plain types + explicit reducers | ✅ [devflow.state.ts](../../src/orchestration/graph/devflow.state.ts) |
| `Send` routers → plain `FanoutTarget[]` routers | ✅ [topology.ts](../../src/orchestration/graph/topology.ts) |
| `PostgresSaver` checkpointer → `OrchestrationRun.checkpointState` (Prisma JSON) | ✅ [checkpointer.ts deleted; service `loadCheckpointState`/`persist`] |
| `NodeInterrupt` gates → explicit pause/resume + `driveRun(fromPhase)` | ✅ [orchestration.service.ts](../../src/orchestration/orchestration.service.ts) |
| Mock work-order `StateGraph` → `runMockWorkOrders()` plain method | ✅ |
| Mid-run control (cancel/pause/resume/retry/skip/modify) re-based on checkpointState | ✅ |
| Eve delegation provider (`ORCHESTRATION_LLM_ENGINE=eve`) | ✅ [eve-llm.provider.ts](../../src/orchestration/providers/eve-llm.provider.ts) |
| `@langchain/*` removed from package.json; all imports gone from `src/` | ✅ |
| Tests updated (topology, sequencer, control, orchestration spec) | ✅ 398 passing; 3 failures are pre-existing and unrelated |

**Verification:** `tsc` clean on all changed source; `prisma validate` ✅; migration unit tests
(20) + orchestration spec (23) green. The only remaining typecheck/test failures predate this
work (test-harness debt in `protocol.test.ts`, `stream-emitter.spec.ts`, `graph-llm-provider.spec.ts`,
the validator retry-budget test, and a `projectTask.id` literal).

This document is the single source of truth for replacing the LangGraph orchestration
engine in `devflow-backend` with [Vercel Eve](https://vercel.com/docs/eve). It records the
decision, the architecture, a phased implementation plan, a file-by-file impact map, the
cutover runbook, and rollback.

---

## 1. Why this is a re-architecture, not a dependency swap

LangGraph and Eve are built on opposite control-flow philosophies:

| | LangGraph (today) | Eve (target) |
|---|---|---|
| Control flow | **Deterministic DAG** defined in code ([topology.ts](../../src/orchestration/graph/topology.ts)) | **Model-driven** — the LLM decides which tools/subagents to call |
| Unit of work | A `StateGraph` node | A subagent / tool, discovered from the `agent/` directory |
| Durability | `PostgresSaver` checkpoints in the `orchestration` schema | Vercel **Workflows** event-log replay |
| Human-in-the-loop | `NodeInterrupt` + `graph.updateState()` | Built-in **approvals** |
| Parallelism | `Send[]` fan-out | `Promise.all` over subagents / built-in `agent` tool |
| Hosting | In-process inside the NestJS monolith | Its own app on Vercel Functions + Fluid Compute |
| Compute for generated code | None (static checkers only) | Per-agent **sandbox** (can run `tsc`, etc.) |

Because of this, we do **not** try to make Eve replicate the DAG. In the Hybrid strategy
NestJS keeps the deterministic backbone and Eve provides the agent runtime.

## 2. What actually depends on LangChain

Verified by source audit (not just `package.json`):

| Package | Real usage | Disposition |
|---|---|---|
| `@langchain/langgraph` | `StateGraph`, `Annotation`, `Send`, `NodeInterrupt`, `START/END`, `graph.stream/invoke/updateState` in [graph/](../../src/orchestration/graph/) and [orchestration.service.ts](../../src/orchestration/orchestration.service.ts) | Replace with `OrchestrationSequencer` + Prisma run-state |
| `@langchain/langgraph-checkpoint-postgres` | `PostgresSaver` in [checkpointer.ts](../../src/orchestration/graph/checkpointer.ts) | Replace with `OrchestrationRun.checkpointState` (Prisma) |
| `@langchain/core` | One `RunnableConfig` **type** import + a tracer comment | Delete (trivial) |
| `@langchain/openai` | **Not imported anywhere in `src/`** | Dead dependency — remove now |

Key insight: **LLM calls already do not use LangChain.** They are raw `fetch` in
[base-llm.provider.ts](../../src/orchestration/providers/base-llm.provider.ts) with bespoke
multi-provider fallback, JSON repair, streaming, and a concurrency limiter. This logic is
valuable and is **preserved** — see §4 model routing.

> There are **two** LangGraph graphs: the main DevFlow graph in
> [devflow.graph.ts](../../src/orchestration/graph/devflow.graph.ts) and the *mock work-order*
> `StateGraph` built inline in `orchestration.service.ts` (~line 1536). **Both** must be ported.

## 3. The integration-boundary finding (drives the Hybrid design)

The agent nodes (e.g. [backend-agent.node.ts](../../src/orchestration/nodes/backend-agent.node.ts))
are **not** thin prompt wrappers. Each one is woven into NestJS DI:

- `MemoryService` — pgvector RAG context + skip-candidate reuse
- `EventLogService` — supervisor event log
- `ProjectScaffolderService` — deterministic file scaffolding merged with LLM output
- `OutputValidationService` — zod + syntax/cross-artifact validation
- `PrismaService` — artifact persistence
- `StreamEmitter` — live socket.io token/progress streaming

The only externalizable part of a node is the single `graphLlm.generateJson(...)` call.
Therefore the Hybrid boundary is:

```
KEEP IN NESTJS: sequencing, gates, memory/RAG, scaffolding, validation,
                GitHub commit, Prisma writes, socket.io streaming
MOVE TO EVE:    the LLM generation turn for each agent (+ optional sandbox typecheck)
```

This means the **first** safe increment treats Eve as a drop-in for `generateJson`
(the `EveClient`/`EveLlmProvider` below), and the **deeper** Eve-native evolution
(relocating memory/scaffold/validation into Eve tools so codegen happens in the sandbox)
is a later, optional phase documented in §8.

## 4. Target architecture (Hybrid)

```
Frontend (Next.js, UNCHANGED)
        │  socket.io  (UNCHANGED)
        ▼
NestJS on Render                         Eve agent service on Vercel
  OrchestrationSequencer ──HTTP/SSE──►     agent/agent.ts          (model)
    (replaces graph.stream)                agent/instructions.md
  OrchestrationRun (Prisma run-state)      agent/subagents/*       (frontend, backend,
    (replaces PostgresSaver)                 database, architecture, parse, negotiate, critique)
  Gates 1 & 2 (kept, socket.io)            agent/tools/typecheck.ts (sandbox)
  output-validation/ (kept)                Agent Runs dashboard (tracing)
  github-commit (kept)                     durable turns via Workflows
  OrchestrationEmitter (kept)
```

**Model routing decision:** the Eve agent calls models through Vercel **AI Gateway**
(model strings like `openai/gpt-5.4-mini`). To preserve our bespoke fallback + JSON-repair
behavior, the agent subagents wrap generation with the same contract our
`base-llm.provider` enforces (strict JSON shape, repair on parse failure). The NestJS
`EveClient` keeps the existing timeout/concurrency limiter from
[llm-runtime.ts](../../src/orchestration/providers/llm-runtime.ts).

## 5. Phased plan & progress

| Phase | Scope | Risk | Status |
|---|---|---|---|
| **0** | De-risk spike: scaffold Eve, port one subagent, confirm JSON parity | low | ✅ scaffold delivered (`devflow-eve-agent/`) — **needs your `npx` run + deploy** |
| **1** | Full Eve agent project (all subagents, typecheck tool) | medium | ✅ files delivered — **needs deploy + prompt tuning** |
| **2** | `EveClient` + feature-flagged delegation in NestJS | medium | ◐ `EveClient` + config delivered; node switch + `OrchestrationSequencer` documented (§6) |
| **3** | Cut over run-state to `OrchestrationRun.checkpointState`; rewire gates | medium | ☐ runbook only (§7) — gated on live Eve + green tests |
| **4** | Remove `@langchain/*`, delete `graph/`, drop `orchestration` checkpoint tables, port mock graph | medium | ☐ runbook only (§7) — final, irreversible step |

Legend: ✅ done · ◐ partially implemented · ☐ documented, not executed.

> **Why Phases 3–4 are not auto-executed:** they delete a working engine and DB state.
> They are only safe once the Eve service is deployed, `ORCHESTRATION_LLM_ENGINE=eve`
> has run green through the full `vitest` suite + the `smoke:*` scripts, and in-flight
> LangGraph runs are drained. Execute them deliberately per §7.

## 6. Implementation details

### 6.1 Eve agent project — `devflow-eve-agent/`
Separate deployable (its own Vercel project). Layout:

```
devflow-eve-agent/
  package.json
  README.md
  agent/
    agent.ts            defineAgent({ model })
    instructions.md     shared system prompt + JSON-only contract
    subagents/
      frontend.ts  backend.ts  database.ts  architecture.ts
      requirements-parser.ts  contract-negotiator.ts  self-critique.ts
    tools/
      typecheck.ts      runs tsc/sql parse in the sandbox
```

Each subagent mirrors the corresponding `*_AGENT_SYSTEM` prompt from
[agent-prompts.ts](../../src/orchestration/prompts/agent-prompts.ts) and returns the
**same** JSON shape (`{ filePath, content, language }[]`) so NestJS validation is unchanged.

### 6.2 NestJS `EveClient`
`src/orchestration/providers/eve-client.provider.ts` — posts a turn to
`POST {EVE_SERVICE_URL}/eve/v1/session`, forwards SSE token deltas to `onToken`, parses the
final JSON. Reuses `withLlmRequest` for timeout/concurrency. **Additive — wired into the
module but not yet on the request path.**

### 6.3 Node → engine routing (`AgentLlmRouter`) — IMPLEMENTED
The 6 LLM agent nodes (`requirements-parser`, `contract-negotiator`,
`frontend/backend/database-agent`, `self-critique`) no longer inject `GraphLlmProvider`
directly — they inject [AgentLlmRouter](../../src/orchestration/providers/agent-llm.router.ts)
as `this.llm`. The router exposes the same `generateJson`/`model` surface and picks the backend
per turn:

```ts
// AgentLlmRouter.generateJson
return this.useEve() && this.eve
  ? this.eve.generateJson<T>(options)   // EveLlmProvider → Eve service
  : this.graph.generateJson<T>(options); // GraphLlmProvider → in-process fetch
```

`useEve()` is true only when `ORCHESTRATION_LLM_ENGINE=eve` **and** `EVE_SERVICE_URL` is set;
otherwise it transparently falls back to the graph provider, so flipping the flag without a
deployed Eve service degrades gracefully. `validator` and `github-commit` call no LLM, so they
were left untouched. This makes the node layer engine-agnostic — no node knows which backend
served its turn.

### 6.4 `OrchestrationSequencer` (replaces `graph.stream`)
Plain TS that reproduces the [topology.ts](../../src/orchestration/graph/topology.ts) order:

```
parse → negotiate → Gate1
      → Promise.all(frontend, backend, database, architecture)
      → self-critique → validate
      → (retryPlan ? Promise.all(failing agents) : Gate2)
      → commit → mark_delivered
```

- Fan-out `Send[]` → `Promise.all`. Routers (`gate1Router`, `validatorRouter`, `gate2Router`)
  are already **pure, unit-tested** functions — keep them as-is.
- Gate pause: write `OrchestrationRun.status=PAUSED` + `checkpointState` (the `DevFlowState`
  snapshot) and return. `resumeGate1/2` reload `checkpointState` and continue.
- Streaming is preserved: wrap each step with the same lifecycle/telemetry emits the
  `instrument()` wrapper does today.

## 7. Cutover runbook (Phases 3–4 — execute manually)

**Pre-req:** Eve service deployed; `EVE_SERVICE_URL`/`EVE_SERVICE_TOKEN` set on Render.

1. `ORCHESTRATION_LLM_ENGINE=eve` in a staging env. Run `npm run test` and every
   `npm run smoke:*`. Confirm artifact quality parity against a golden project.
2. Flip nodes to `EveLlmProvider` (§6.3) and re-run the suite.
3. Enable the `OrchestrationSequencer` via `ORCHESTRATION_ENGINE=sequencer`; verify gate
   pause/resume against `OrchestrationRun.checkpointState`.
4. Drain in-flight LangGraph runs (let them finish or cancel). Do **not** migrate
   `orchestration` checkpoint rows.
5. **Phase 4 (irreversible):** remove `@langchain/langgraph`,
   `@langchain/langgraph-checkpoint-postgres`, `@langchain/core`, `@langchain/openai` from
   `package.json`; delete `graph/checkpointer.ts`, `graph/devflow.graph.ts`; convert
   `graph/devflow.state.ts` Annotations → plain types; port the mock work-order graph in
   `orchestration.service.ts`; update tests (`topology.test.ts`,
   `orchestration.rungraph.test.ts`, `simulation-nodes*`) and the `smoke:langgraph-github`
   script name; drop the now-unused checkpoint tables from the `orchestration` schema.

## 8. Optional Phase 5 — Eve-native (sandbox codegen)
Relocate memory/scaffold/validation into Eve **tools** so generation, typechecking, and
self-repair happen inside the sandbox before artifacts return to NestJS. Highest payoff
(real compile-checked output) but largest change; only pursue after Hybrid is stable.

## 9. Rollback
Every step before Phase 4 is reversible by flipping `ORCHESTRATION_LLM_ENGINE=graph` and
`ORCHESTRATION_ENGINE=graph`. Phase 4 is the point of no return — tag the repo
(`git tag pre-eve-cutover`) before executing it.

## 10. Risks
1. **Beta API drift** — Eve is one week old; keep the `EveClient` boundary thin.
2. **Cross-service latency/reliability** — each run now makes N HTTP calls; rely on
   `withLlmRequest` timeouts + add retries.
3. **Provider-abstraction loss** — fallback/JSON-repair must live inside Eve subagents.
4. **Two graphs** — don't forget the mock work-order supervisor graph.
5. **Sandbox cost** — Phase 5 sandbox compute is billed; gate behind complexity.
