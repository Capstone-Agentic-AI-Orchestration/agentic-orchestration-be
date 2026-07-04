# Run Supervisor — Implementation Reference

Phase 2B implementation. This document describes the deployed system, not a design proposal.

---

## Problem

LangGraph's fire-and-forget execution model means the HTTP layer returns immediately after starting a run. When a graph node hangs — Anthropic API timeout, network partition, Postgres deadlock — the run silently stalls. The project status never advances and no human is notified.

The Run Supervisor solves this with two cooperating services:

- **EventLogService** — called by every agent node at STARTED and COMPLETED. Records node-level lifecycle events and maintains the cumulative token budget in the `run_budgets` table.
- **RunSupervisorService** — polls every 60 seconds for runs that have had no EventLog activity in the past 10 minutes and applies a deterministic recovery strategy.

Neither service makes LLM calls or external HTTP requests. Cost is pure Postgres I/O.

---

## State Machine

```
                    ┌─────────────────┐
                    │     PENDING     │
                    └────────┬────────┘
                             │ startRun() → RunBudget created
                             ▼
                    ┌─────────────────┐
                    │   ACTIVE RUN    │  ← any status not in {DELIVERED, FAILED}
                    │  (one or more   │
                    │   nodes firing) │
                    └────────┬────────┘
                             │
            ┌────────────────┴──────────────────┐
            │ EventLog entry older than          │ Normal completion
            │ 10 minutes (supervisor detects)    ▼
            ▼                          ┌──────────────────┐
   ┌─────────────────┐                 │  AWAITING_GATE_1 │
   │  STUCK detected │                 │  AWAITING_GATE_2 │
   └────────┬────────┘                 │  DELIVERED       │
            │                          └──────────────────┘
    ┌───────┴───────┐
    │ retryCount    │
    │ < maxRetries  │
    │ AND budget    │
    │ not exhausted?│
    └───┬───────────┘
        │ YES                   NO
        │                       │
        ▼                       ▼
┌───────────────┐      ┌─────────────────┐
│  AUTO-RETRY   │      │  ESCALATE TO    │
│ retryCount++  │      │  HUMAN          │
│ log STUCK     │      │  log ESCALATED  │
│ reset status  │      │  status = FAILED│
└───────┬───────┘      └─────────────────┘
        │
        └──► OrchestrationService resumes
             graph from LangGraph checkpoint
```

Terminal states: `DELIVERED`, `FAILED`. The supervisor never touches runs in these states.

---

## EventLog Schema

Every node lifecycle transition writes one row. The supervisor uses `MAX(occurredAt)` per project to detect stalls.

```
model EventLog {
  id         String   @id @default(cuid())
  projectId  String
  nodeName   String   // "backend_agent" | "frontend_agent" | "database_agent"
                      // "architecture_agent" | "contract_negotiator" | "supervisor"
  eventType  String   // STARTED | COMPLETED | FAILED | RETRIED | STUCK | ESCALATED
  costMeta   Json     @default("{}")
                      // COMPLETED: { inputTokens, outputTokens, model }
                      // FAILED:    { error: string }
                      // ESCALATED: { reason: string }
  runTokens  Int      @default(0)   // cumulative tokensConsumed at event time
  occurredAt DateTime @default(now())
  @@map("event_logs")
}
```

---

## RunBudget Schema

One row per project, created by `OrchestrationService.startRun()`.

```
model RunBudget {
  id             String   @id @default(cuid())
  projectId      String   @unique
  tokenBudget    Int      @default(200000)   // 200k tokens per run
  tokensConsumed Int      @default(0)        // incremented atomically on COMPLETED
  retryCount     Int      @default(0)        // incremented by supervisor on auto-retry
  maxRetries     Int      @default(2)        // hard ceiling; escalate when reached
  updatedAt      DateTime @updatedAt
  @@map("run_budgets")
}
```

---

## EventLogService

Location: `src/supervisor/event-log.service.ts`

### Core invariant

Every public method wraps its Prisma calls in `Promise.allSettled`. A failure to write a log row **never** propagates to the calling agent node. Agents continue execution unconditionally.

### Method contract

| Method | EventType written | Side effects |
|--------|-------------------|--------------|
| `logStarted(projectId, nodeName)` | `STARTED` | None |
| `logCompleted(projectId, nodeName, costMeta)` | `COMPLETED` | Atomically increments `RunBudget.tokensConsumed` by `inputTokens + outputTokens`. Emits budget warnings at ≥90%. Calls `logEscalated` at ≥100%. |
| `logFailed(projectId, nodeName, error)` | `FAILED` | None |
| `logStuck(projectId, nodeName)` | `STUCK` | None |
| `logEscalated(projectId, nodeName, reason)` | `ESCALATED` | None |

### Budget enforcement thresholds

```
tokensConsumed / tokenBudget   Action
─────────────────────────────  ──────────────────────────────────────────
< 0.90                         No action
≥ 0.90 (warn threshold)        WARN log: "Budget warning: X/Y tokens (Z%)"
≥ 1.00 (exhausted)             WARN log + logEscalated() called immediately
                               Supervisor will detect ESCALATED on next poll
                               and set project status = FAILED
```

The threshold constant is `BUDGET_WARN_THRESHOLD = 0.9` in `event-log.service.ts`.

### Token increment — atomic update pattern

`logCompleted` uses a Prisma `update` with `{ increment: N }` to ensure the counter is incremented atomically even under concurrent node execution:

```typescript
const updated = await this.prisma.runBudget.update({
  where: { projectId },
  data: { tokensConsumed: { increment: inputTokens + outputTokens } },
  select: { tokensConsumed: true, tokenBudget: true },
});
// updated.tokensConsumed is the POST-increment value — safe to use for
// the runTokens field on the EventLog row and for threshold checks.
```

---

## RunSupervisorService

Location: `src/supervisor/run-supervisor.service.ts`

### Polling

```typescript
@Interval(60_000)   // fires 60 seconds after boot, then every 60 seconds
async supervisorTick(): Promise<void>
```

`@Interval` is from `@nestjs/schedule`. The module must be bootstrapped via `ScheduleModule.forRoot()` in `AppModule`.

### Stuck detection query

```sql
SELECT
  p.id,
  p.status,
  rb."retryCount",
  rb."maxRetries",
  rb."tokensConsumed",
  rb."tokenBudget"
FROM "Project" p
INNER JOIN run_budgets rb ON rb."projectId" = p.id
WHERE p.status NOT IN ('DELIVERED', 'FAILED')
  AND (
    SELECT MAX(el."occurredAt")
    FROM event_logs el
    WHERE el."projectId" = p.id
  ) < NOW() - INTERVAL '10 minutes'
```

Projects with **no EventLog rows at all** are also returned because `MAX(NULL) < threshold` evaluates to true in Postgres. This correctly identifies projects where STARTED was never written (e.g., the node crashed before the first log call).

### Recovery algorithm

```
for each stuck project:
  if retryCount >= maxRetries OR tokensConsumed >= tokenBudget:
    escalateToHuman(projectId, reason)
  else:
    prisma.runBudget.update({ retryCount: { increment: 1 } })
    eventLog.logStuck(projectId, 'supervisor')
    prisma.project.update({ status: project.status })   ← touch updatedAt
    // OrchestrationService detects the active status and resumes the graph
```

All three writes in the auto-retry path are issued via `Promise.allSettled` so a partial failure does not leave the project in an inconsistent state between retries.

### escalateToHuman

```typescript
async escalateToHuman(projectId: string, reason: string): Promise<void>
```

1. Reads `RunBudget` and latest `EventLog` row for diagnostic context (allSettled — read failure is non-fatal).
2. Emits a `WARN` log with: token consumption ratio, retry count, last known node + event type, timestamp, and reason string.
3. Updates `project.status = 'FAILED'` and writes an `ESCALATED` EventLog row (allSettled).

The supervisor does **not** send emails or call webhooks. Notification hooks are an operational concern and are not implemented in Phase 2B.

---

## Escalation Flow (end-to-end)

```
  Agent node  →  logCompleted()
                    │
                    ├─ tokensConsumed >= tokenBudget?
                    │         YES
                    │         └─► logEscalated(projectId, nodeName, 'Token budget exhausted')
                    │                  │
                    │                  └─► ESCALATED row in event_logs
                    │                      (supervisor detects on next poll)
                    │
  60s later   →  supervisorTick()
                    │
                    ├─ findStuckProjects()
                    │    └─ project has ESCALATED event or no recent events
                    │
                    └─► escalateToHuman(projectId, reason)
                              │
                              ├─ WARN log (full context for on-call)
                              ├─ project.status = 'FAILED'
                              └─ ESCALATED row in event_logs
```

---

## Agent Node Instrumentation

Each instrumented node follows this pattern:

```typescript
// 1. Log STARTED before the LLM call
await this.eventLog.logStarted(state.projectId, 'backend_agent');

try {
  const response = await this.anthropic.messages.create({ ... });

  // 2. Log COMPLETED after successful response
  await this.eventLog.logCompleted(state.projectId, 'backend_agent', {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model: 'claude-haiku-4-5',
  });

  return { artifacts };
} catch (error) {
  // Note: logFailed is available but not currently wired to catch blocks
  // in Phase 2B. The supervisor detects failure via the absence of a
  // COMPLETED event (the STARTED event keeps updatedAt fresh until the
  // supervisor's 10-minute threshold fires).
  return { error: `NodeName failed: ${message}` };
}
```

Instrumented nodes (Phase 2B):

| Node file | nodeName logged |
|-----------|-----------------|
| `backend-agent.node.ts` | `backend_agent` |
| `frontend-agent.node.ts` | `frontend_agent` |
| `database-agent.node.ts` | `database_agent` |
| `architecture-agent.node.ts` | `architecture_agent` |
| `contract-negotiator.node.ts` | `contract_negotiator` |

---

## Module Wiring

```
AppModule
  ├── ScheduleModule.forRoot()   ← enables @Interval / @Cron decorators globally
  ├── PrismaModule (@Global)
  └── SupervisorModule
        ├── PrismaModule (explicit import for documentation clarity)
        ├── ScheduleModule.forRoot() (comment only — AppModule is canonical)
        ├── EventLogService     ← exported
        └── RunSupervisorService ← exported, owns the @Interval tick

OrchestrationModule
  └── (node providers inject EventLogService via SupervisorModule export)
```

`SupervisorModule` is exported from `AppModule` so `EventLogService` is available
for injection anywhere in the application, including inside `OrchestrationModule`'s
node providers.

---

## Environment Configuration

No new environment variables are introduced in Phase 2B. All thresholds are
compile-time constants in the service files:

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `POLL_INTERVAL_MS` | 60 000 ms | `run-supervisor.service.ts` | Supervisor polling cadence |
| `STUCK_THRESHOLD_MS` | 600 000 ms (10 min) | `run-supervisor.service.ts` | Time without EventLog entry before a run is flagged |
| `BUDGET_WARN_THRESHOLD` | 0.9 | `event-log.service.ts` | Token consumption ratio that triggers a WARN log |
| `tokenBudget` (schema default) | 200 000 | `prisma/schema.prisma` | Default token budget per run |
| `maxRetries` (schema default) | 2 | `prisma/schema.prisma` | Auto-retry ceiling per run |

To tune these for production, modify the constants and redeploy. A future phase may promote them to `ConfigService`-backed environment variables.

---

## Verification Checklist

After deployment, confirm the following:

1. **EventLog rows appear**: Start a project run, check `SELECT * FROM event_logs WHERE "projectId" = '<id>'`. Expect STARTED and COMPLETED rows for each agent node.
2. **RunBudget increments**: After each COMPLETED event, `tokensConsumed` in `run_budgets` increases by `inputTokens + outputTokens`.
3. **Supervisor tick fires**: Set `STUCK_THRESHOLD_MS` to 1 minute temporarily, start a run, then check logs for "Supervisor tick — scanning for stuck runs" every 60 seconds.
4. **Auto-retry increments retryCount**: Let a run stall past the threshold; verify `retryCount` increments in `run_budgets` and a STUCK row appears in `event_logs`.
5. **Escalation at maxRetries**: Set `maxRetries = 1` on a test row, let it retry once, then confirm `project.status = 'FAILED'` and an ESCALATED row in `event_logs`.
6. **Budget exhaustion escalation**: Set `tokenBudget = 1` on a test row, run any agent node; confirm the WARN log and ESCALATED event appear in `event_logs`.
