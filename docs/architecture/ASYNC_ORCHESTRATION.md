# Async Orchestration Architecture

Status: active target architecture.

## Boundary

`agentic-orchestration-fe` calls only `agentic-orchestration-be`.

`agentic-orchestration-be` is the control plane:

- authenticates Supabase users and enforces roles
- owns project, work-order, run, gate, artifact, memory, and delivery state
- creates orchestration runs and returns `accepted/runId`
- dispatches long-running run execution asynchronously
- streams run events over Socket.IO `/devflow`
- verifies generated artifacts before persistence and GitHub delivery
- calls `agentic-orchestration-ag` only through the provider layer

`agentic-orchestration-ag` is the execution plane:

- performs Eve agent turns
- runs subagent cognition and self-repair
- uses sandbox/typecheck tools where available
- returns JSON artifacts to the backend contract

The frontend must not call Eve directly. Eve has no direct database authority.

## Runtime Flow

```text
FE -> BE POST /projects/:id/orchestration/start
BE validates auth, project readiness, and work orders
BE writes Project.runId + OrchestrationRun(status=RUNNING)
BE returns { accepted: true, runId }
BE dispatcher starts run execution asynchronously
BE sequencer loads memory/scaffolding context and calls provider layer
Provider layer delegates to Eve when configured, otherwise graph fallback
BE validates artifacts, persists results, updates run state
BE emits typed orchestration:event messages over /devflow
FE renders stored state and live events
```

## Dispatch Mode

Current mode:

```env
ORCHESTRATION_DISPATCHER_MODE="in-process"
```

`in-process` uses `OrchestrationRunDispatcher` to schedule background run execution after
the API response path has persisted run state. This preserves the public contract while
keeping deployment simple.

Future durable mode should keep the same dispatcher interface and swap implementation:

- BullMQ + Redis when we want explicit queue workers and retries.
- Supabase Queues when we want fewer moving parts inside the Supabase/Postgres platform.

Do not let the frontend depend on the queue vendor.

## Performance Rules

- All long-running generation must be asynchronous.
- API start/resume calls should return identifiers and current state, not generated artifacts.
- UI state should come from stored run state plus Socket.IO events.
- Completed artifacts should be persisted and fetched by id; do not regenerate for viewing.
- Provider timeouts and concurrency limits stay backend-owned.

## Deployment Requirements

Backend:

- Supabase Postgres `DATABASE_URL`
- Supabase Auth URL and server-side service key where needed
- `ORCHESTRATION_LLM_ENGINE=eve`
- `EVE_SERVICE_URL` for real Eve execution
- `EVE_SERVICE_TOKEN` when route auth is enabled

Frontend:

- `NEXT_PUBLIC_API_URL` points to backend origin
- `NEXT_PUBLIC_SOCKET_URL` points to backend origin
- no Eve URL or service token

Eve:

- deployed separately from the backend
- returns the backend artifact JSON contract
- does not own project/run persistence
