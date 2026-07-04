# Projects API Reference

Base URL: `http://localhost:4000`

All endpoints return JSON. Error responses follow the shape:
```json
{ "statusCode": number, "message": string, "error": string }
```

---

## Health

### GET /health
Returns 200 if the API is running.

**Response**
```json
{ "status": "ok" }
```

---

## Projects

### POST /projects
Create a new project and start the orchestration pipeline.

**Request body**
```json
{
  "companyName": "Acme Corp",
  "brief": "A SaaS platform for managing employee onboarding workflows.",
  "stackKey": "nextjs-nestjs-postgres"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `companyName` | string | Yes | 1–100 characters |
| `brief` | string | Yes | Free-text project description, 10–5000 characters |
| `stackKey` | string | Yes | Identifies the tech stack template |

**Response — 201 Created**
```json
{
  "id": "clxyz...",
  "companyName": "Acme Corp",
  "brief": "A SaaS platform...",
  "stackKey": "nextjs-nestjs-postgres",
  "status": "PENDING",
  "runId": null,
  "repoUrl": null,
  "createdAt": "2026-04-26T10:00:00.000Z",
  "updatedAt": "2026-04-26T10:00:00.000Z"
}
```

The pipeline starts asynchronously. Poll `GET /projects/:id/status` to track progress.

---

### GET /projects
List all projects (summary view).

**Response — 200 OK**
```json
[
  {
    "id": "clxyz...",
    "companyName": "Acme Corp",
    "status": "AWAITING_GATE_1",
    "createdAt": "2026-04-26T10:00:00.000Z"
  }
]
```

---

### GET /projects/:id
Get a single project with gate events.

**Response — 200 OK**
```json
{
  "id": "clxyz...",
  "companyName": "Acme Corp",
  "brief": "...",
  "stackKey": "nextjs-nestjs-postgres",
  "status": "AWAITING_GATE_1",
  "runId": "cla1b2...",
  "repoUrl": null,
  "createdAt": "...",
  "updatedAt": "...",
  "gates": [
    {
      "id": "clg1...",
      "gateType": "ARCHITECTURE_REVIEW",
      "decision": "APPROVED",
      "notes": "Looks good",
      "decidedAt": "2026-04-26T10:05:00.000Z"
    }
  ],
  "_count": { "artifacts": 8 }
}
```

**Project status values**

| Status | Description |
|--------|-------------|
| `PENDING` | Project created, pipeline not yet started |
| `PARSING_REQUIREMENTS` | RequirementsParser node running |
| `NEGOTIATING_CONTRACT` | ContractNegotiator node running |
| `AWAITING_GATE_1` | Paused at Gate 1 — awaiting human architecture review |
| `GENERATING_CODE` | Code agents running (frontend, backend, database, architecture) |
| `AWAITING_GATE_2` | Paused at Gate 2 — awaiting human code review |
| `COMMITTING` | GithubCommit node running |
| `DELIVERED` | Pipeline complete, code pushed to GitHub |
| `FAILED` | Terminal failure |

---

### GET /projects/:id/status
Lightweight polling endpoint. Returns the current node and retry count from the LangGraph checkpoint.

**Response — 200 OK**
```json
{
  "status": "GENERATING_CODE",
  "currentNode": "backend_agent",
  "retryCount": 0,
  "error": null
}
```

---

### GET /projects/:id/artifacts
Return all generated artifacts for a project.

**Response — 200 OK**
```json
[
  {
    "id": "cla...",
    "projectId": "clxyz...",
    "agentType": "backend",
    "filePath": "src/modules/users/users.service.ts",
    "content": "import { Injectable }...",
    "createdAt": "2026-04-26T10:03:00.000Z"
  }
]
```

---

### POST /projects/:id/gate-1
Approve or reject Gate 1 (architecture review).

**Request body**
```json
{
  "approved": true,
  "notes": "Architecture looks solid, proceed to code generation."
}
```

| Field | Type | Required |
|-------|------|----------|
| `approved` | boolean | Yes |
| `notes` | string | No |

**Behaviour**
- `approved: true` → resumes the graph from `gate_1_check`, project moves to `GENERATING_CODE`
- `approved: false` → records REJECTED gate event, project moves to `FAILED`, writes MISTAKE memory

**Phase 2A addition**: on rejection, a MISTAKE memory is written for the contract that was rejected.

**Response — 200 OK**
```json
{ "accepted": true }
```

---

### POST /projects/:id/gate-2
Approve or reject Gate 2 (code review).

**Request body**
```json
{
  "approved": true,
  "notes": "All files reviewed and correct."
}
```

**Behaviour**
- `approved: true` → writes SKILL memories (per artifact) + PATTERN memory, resumes graph, project moves to `COMMITTING` then `DELIVERED`
- `approved: false` → writes MISTAKE memories (per artifact), project moves to `FAILED`

**Response — 200 OK**
```json
{ "accepted": true }
```

---

## WebSocket Events (Phase 2E)

The backend exposes a Socket.IO gateway at the `/devflow` namespace on the same port as the HTTP API.

### Connection

```
ws://localhost:4000/devflow
```

### Subscribe to a project room

After connecting, emit a `subscribe` event to join the room for a specific project. All subsequent `project:status` events for that project will be forwarded to the client.

**Emit**
```json
{ "event": "subscribe", "data": { "projectId": "clxyz..." } }
```

### project:status

Emitted by the server whenever the orchestration pipeline transitions to a new status. The client receives this event for every project it has subscribed to.

**Event shape**
```json
{
  "projectId":   "clxyz...",
  "status":      "GENERATING_CODE",
  "currentNode": "gate_1_check",
  "error":       null
}
```

| Field | Type | Description |
|---|---|---|
| `projectId` | string | The project this event belongs to |
| `status` | string | New project status (matches HTTP status values) |
| `currentNode` | string | Graph node that triggered the transition |
| `error` | string \| null | Error message for `FAILED` events; `null` otherwise |

**Status values emitted over WebSocket**

| `status` | `currentNode` | Trigger |
|---|---|---|
| `PARSING_REQUIREMENTS` | `parse_requirements` | `POST /projects` accepted and run started |
| `GENERATING_CODE` | `gate_1_check` | Gate 1 approved via `POST /projects/:id/gate-1` |
| `COMMITTING` | `gate_2_check` | Gate 2 approved via `POST /projects/:id/gate-2` |
| `FAILED` | `gate_rejected` | Any gate rejected |
