# Phase 2 — Local Setup Guide

## Prerequisites

- Docker Desktop installed and running
- Node.js 20+ and npm
- An `.env` file populated from `.env.example`
- Phase 1 already running (`npm run start:dev` succeeded)

---

## Step 1 — Switch to pgvector Docker image

Phase 2A replaces the base `postgres:16-alpine` image with `pgvector/pgvector:pg16`, which bundles the pgvector extension. This is a drop-in replacement — same port (5432), same credentials.

If you have existing Phase 1 data you want to preserve:

```bash
# Export existing data (optional)
docker exec devflow-db pg_dump -U devflow devflow > phase1-backup.sql

# Stop and remove the old container (volume is preserved)
docker compose down
```

If starting fresh:

```bash
docker compose down -v   # removes the postgres_data volume
```

Then start with the new image:

```bash
docker compose up -d db
```

Verify pgvector is available:

```bash
docker exec devflow-backend-db-1 psql -U devflow -c "SELECT * FROM pg_available_extensions WHERE name = 'vector';"
# Should return one row with name = 'vector'
```

---

## Step 2 — Apply checked-in migrations

The checked-in migrations enable the `vector` extension, create the core DevFlow tables, and add the local Supabase-auth compatibility primitives required by the RLS policies.

```bash
# Generate updated Prisma client (picks up new schema)
npm run prisma:generate

# Apply checked-in SQL migrations
npm run prisma:migrate
```

Expected output:
```
All migrations have been successfully applied.
```

Verify the tables exist:

```bash
docker exec devflow-backend-db-1 psql -U devflow -c "\dt agent_memories"
docker exec devflow-backend-db-1 psql -U devflow -c "\di agent_memories_embedding_ivfflat_idx"
```

---

## Step 3 — Add Phase 2 environment variables

Add the following to your `.env` (already in `.env.example`):

```bash
# LangSmith — optional, enable for Phase 2E
# LANGCHAIN_API_KEY="ls__..."
# LANGCHAIN_TRACING_V2="true"

# RunSupervisor — optional, defaults shown
SUPERVISOR_POLL_INTERVAL_MS=30000
SUPERVISOR_STUCK_THRESHOLD_MS=300000
```

No new mandatory variables are required for Phase 2A. `OPENAI_API_KEY` was already required in Phase 1 (used for `gpt-4o-mini` in requirements parsing) and is now also used for `text-embedding-3-small`.

---

## Step 4 — Start the API

```bash
npm run start:dev
```

The API starts on port 4000. All Phase 1 endpoints work unchanged.

---

## Step 5 — Verify memory injection is working

Run a new project through the pipeline and observe logs:

```bash
curl -X POST http://localhost:4000/projects \
  -H "Content-Type: application/json" \
  -d '{"companyName":"TestCo","brief":"Simple todo app","stackKey":"nextjs-nestjs-postgres"}'
```

Expected log output:
```
[BackendAgentNode] [<id>] Backend agent generating files
[MemoryService] Memory read: 0 results for agent=backend (store is empty on first run)
[BackendAgentNode] [<id>] Backend agent generated 7 files (0 memories injected)
```

After approving Gate 2 on a completed run:
```
[OrchestrationService] Gate 2 approved: 8 skill memories + 1 pattern written for project <id>
```

On subsequent runs of the same project type:
```
[BackendAgentNode] [<id>] Backend agent generated 7 files (3 memories injected)
```

---

## Troubleshooting

### "vector type not found" in Prisma migration
The `vector` extension was not enabled. Confirm you are running `pgvector/pgvector:pg16` and not `postgres:16-alpine`:
```bash
docker compose ps
# Check the image column for the db service
```

### EmbeddingService: unexpected vector length
OpenAI returned a different dimension. Confirm `OPENAI_API_KEY` is valid and the model `text-embedding-3-small` is accessible on your account.

### Memory reads returning 0 results
This is expected until Gate 2 has been approved at least once. The memory store is populated only after successful project delivery.

### IVFFlat index error during migration
If Postgres reports an error about the IVFFlat index, it may be because the database has no rows yet. The index creation on an empty table is safe — ensure the migration SQL runs the `CREATE INDEX` after the `CREATE TABLE`.

---

## Phase 2E — WebSocket Real-Time Updates

### Connecting a client to the WebSocket gateway

The gateway runs on the same port as the HTTP API (4000) under the `/devflow` namespace.

```javascript
import { io } from 'socket.io-client';

const socket = io('ws://localhost:4000/devflow');

// Subscribe to status updates for a specific project
socket.emit('subscribe', { projectId: 'clxyz...' });

// Listen for status transitions
socket.on('project:status', (payload) => {
  console.log(payload);
  // {
  //   projectId: 'clxyz...',
  //   status:      'GENERATING_CODE',
  //   currentNode: 'gate_1_check',
  //   error:       null
  // }
});
```

The client joins a Socket.IO room named after the `projectId`. All subscribers watching the same project ID receive the same events. You can subscribe to multiple projects by calling `socket.emit('subscribe', ...)` multiple times.

**Status progression** (in order of typical pipeline flow):

| Event status | Trigger |
|---|---|
| `PARSING_REQUIREMENTS` | Immediately after `POST /projects` starts the run |
| `GENERATING_CODE` | After Gate 1 is approved |
| `COMMITTING` | After Gate 2 is approved |
| `FAILED` | After any gate is rejected |

---

## Phase 2E — LangSmith Tracing Setup

LangSmith provides distributed tracing for every LangGraph node invocation. No code changes are required — the tracer activates automatically when the environment variables are present.

### Enable tracing

1. Create an account at [smith.langchain.com](https://smith.langchain.com) and generate an API key.
2. Add the following to your `.env`:

```bash
LANGCHAIN_API_KEY="ls__your_key_here"
LANGCHAIN_TRACING_V2="true"
LANGCHAIN_PROJECT="devflow"   # groups traces in the LangSmith UI
```

3. Restart the backend:

```bash
npm run start:dev
```

### What is traced

Every node invocation in the LangGraph pipeline — `parse_requirements`, `contract_negotiator`, `frontend_agent`, `backend_agent`, `database_agent`, `architecture_agent`, `validator`, `github_commit` — is automatically captured as a LangSmith run, including:

- Input/output state
- Token usage per LLM call
- Latency per node
- Errors and retries

### Where to view traces

Log in at [app.smith.langchain.com](https://app.smith.langchain.com) and open the **devflow** project. Each pipeline run appears as a top-level trace with child spans for each graph node.
