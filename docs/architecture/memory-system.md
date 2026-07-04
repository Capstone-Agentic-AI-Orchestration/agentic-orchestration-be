# Agent Memory System — Design Document

## Overview

The Agent Memory System gives DevFlow a persistent, searchable store of past agent experiences. Each time a project completes (or is rejected), the system extracts structured learnings from the run and stores them as vector-embedded memories. Future runs query this store before each LLM call to inject relevant context — reducing hallucination, improving consistency, and enabling the skip-generation optimization implemented in Phase 2D.

Phase 2F adds layered memory scopes:

| Scope | Who can read it | Write rule |
|-------|------------------|------------|
| `PROJECT_CORE` | All agents on the same project | Must be promoted by Gate 1, Gate 2, or explicit human review |
| `PROJECT_AGENT` | One agent type on one project | Agent-specific project learnings, artifacts, and mistakes |
| `AGENT_PRIVATE` | One agent type globally | Future global private lessons/templates, without raw project data |
| `GLOBAL_PATTERN` | All agents when relevant | Approved reusable delivery patterns |

Project core memory is authoritative shared project truth. Agent-private and project-agent memories are advisory.

---

## Database Schema

### AgentMemory Table (`agent_memories`)

```sql
CREATE TABLE agent_memories (
  id          TEXT PRIMARY KEY,
  agentType   TEXT NOT NULL,          -- 'requirements' | 'frontend' | 'backend' | 'database' | 'architecture' | 'contract'
  scope       AgentMemoryScope NOT NULL DEFAULT 'AGENT_PRIVATE',
  memoryType  AgentMemoryType NOT NULL, -- SKILL | PATTERN | MISTAKE
  content     TEXT NOT NULL,          -- raw text that was embedded
  embedding   vector(1536) NOT NULL,  -- text-embedding-3-small output
  metadata    JSONB DEFAULT '{}',     -- stackKey, projectType, filePath, etc.
  projectId   TEXT,                   -- nullable: global patterns survive project deletion
  approvedAt  TIMESTAMP,              -- required for PROJECT_CORE reads
  approvalSource TEXT,                -- GATE_1 | GATE_2 | HUMAN_REVIEW | legacy/system markers
  createdAt   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_agent_memories_agent_type ON agent_memories (agentType, memoryType);
CREATE INDEX idx_agent_memories_project    ON agent_memories (projectId);

-- ANN index (development: IVFFlat, production: HNSW)
CREATE INDEX idx_agent_memories_embedding
  ON agent_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
```

### Memory Types

| Type | Written when | Purpose |
|------|-------------|---------|
| `SKILL` | Successful parse (requirements) OR Gate 2 APPROVED (all other agents) | Successful prompt+output pair for a specific task |
| `PATTERN` | Gate 2 APPROVED | Full contract + fileManifest that resulted in DELIVERED status |
| `MISTAKE` | Gate 1 or Gate 2 REJECTED, OR validator failure | Rejected/invalid content + notes |

---

## Layered Read Order

Each agent invocation now reads memory in separate buckets and injects them as separate prompt sections:

1. `PROJECT_CORE` for the current project, only if human-approved.
2. `PROJECT_AGENT` for the current agent type and project.
3. `AGENT_PRIVATE` global memory for the current agent type.
4. `MISTAKE` memories for the current project/agent or global private agent scope.
5. `GLOBAL_PATTERN` records with approval metadata.

The separation is deliberate: approved project truth should have higher authority than an agent's private advisory history.

## Human Approval Gate Rule

Shared project memory is written only through `MemoryService.writeProjectCoreMemory()`. That method rejects any approval source other than `GATE_1`, `GATE_2`, or `HUMAN_REVIEW`.

- Gate 1 approval promotes the approved architecture contract into `PROJECT_CORE`.
- Gate 2 approval promotes the approved delivery summary into `PROJECT_CORE`.
- Gate rejections write `MISTAKE` memories but do not promote shared truth.
- Validator failures write advisory `MISTAKE` memories scoped to the implicated agent.

This keeps "what the project believes" behind a human approval gate while still allowing agents to learn private implementation lessons.

## Embedding Strategy

### Model
- `text-embedding-3-small` from OpenAI
- Dimensions: 1536
- Cost: $0.02 / 1M tokens (cheapest option)
- Max input: 8191 tokens (content truncated to 24,000 chars before embedding)

### Content Preparation

Each memory type has a structured text format optimised for embedding:

**SKILL (requirements)**
```
FILE: requirements/<projectId>.json
STACK: nextjs-nestjs-postgres
TYPE: SaaS web app

{ "projectType": "SaaS web app", "features": [...], ... }
```

**SKILL (code agent)**
```
FILE: src/modules/users/users.service.ts
STACK: nestjs-next-postgres
TYPE: B2B SaaS

<artifact content>
```

**PATTERN**
```
PROJECT TYPE: e-commerce platform
STACK KEY: nextjs-nestjs-postgres
COMPLEXITY: complex
FILES: src/app/page.tsx, src/modules/products/...
CRITERIA: Users can browse products; Cart persists across sessions; ...
```

**MISTAKE**
```
GATE: GATE_2
AGENT: backend
STACK: nestjs-next-postgres
REJECTION REASON: Missing authentication guards on admin endpoints

REJECTED CONTENT:
<first 2000 chars of the rejected artifact>
```

---

## Memory Write Events — Full Inventory

The following table lists every event that triggers a memory write, the responsible caller, and the memory type produced.

| Event | Caller | agentType | memoryType | Notes |
|-------|--------|-----------|------------|-------|
| Requirements successfully parsed | `RequirementsParserNode` | `requirements` | `SKILL` | Brief + parsed JSON written as a skill to train future parsers |
| Validator detects structural failures | `ValidatorNode` | failing agent(s) | `MISTAKE` | One record per implicated agent type; written before retry scheduling |
| Gate 1 REJECTED by human | `OrchestrationService.resumeGate1()` | `contract` | `MISTAKE` | Rejected contract + gate notes |
| Gate 2 REJECTED by human | `OrchestrationService.resumeGate2()` | per artifact | `MISTAKE` | One record per artifact; rejected content + gate notes |
| Gate 2 APPROVED by human | `OrchestrationService.resumeGate2()` | per artifact | `SKILL` | One record per artifact (frontend/backend/database/architecture) |
| Gate 2 APPROVED by human | `OrchestrationService.resumeGate2()` | `contract` | `PATTERN` | Full contract + fileManifest for the DELIVERED run |

### Code-Level References

**RequirementsParserNode** (`src/orchestration/nodes/requirements-parser.node.ts`):
```typescript
await this.memory.writeSkill({
  agentType: 'requirements',
  systemPrompt: prompt,
  artifactContent: JSON.stringify(requirements, null, 2),
  filePath: `requirements/${state.projectId}.json`,
  projectId: state.projectId,
  stackKey: state.stackKey,
  projectType: requirements.projectType,
});
```

**ValidatorNode** (`src/orchestration/nodes/validator.node.ts`):
```typescript
// Called for each implicated agent type on validation failure
await this.memory.writeMistake({
  agentType,
  rejectedContent: validationIssueText,
  rejectionNotes: `Validator rejected output at retry N: ...`,
  projectId: state.projectId,
  gateType: 'GATE_2',
  stackKey: state.stackKey,
});
```

**OrchestrationService** (`src/orchestration/orchestration.service.ts`):
```typescript
// Gate 1 rejection → one MISTAKE for contract
memory.writeMistake({ agentType: 'contract', rejectedContent: ..., gateType: 'GATE_1', ... })

// Gate 2 rejection → one MISTAKE per artifact
for (const artifact of state.artifacts) {
  memory.writeMistake({ agentType: artifact.agentType, gateType: 'GATE_2', ... })
}

// Gate 2 approval → one SKILL per artifact + one PATTERN for contract
for (const artifact of state.artifacts) {
  memory.writeSkill({ agentType: artifact.agentType, filePath: ..., content: ..., ... })
}
memory.writePattern({ contract, stackKey, projectId })
```

---

## Read Flow — Memory Injection

Called by every agent node before its LLM invocation.

```
1. Build query string (Phase 2C enhancement — companyName included):
   query = [projectType, stackKey, features..., companyName].filter(Boolean).join(' ')

2. Embed query:
   vector = EmbeddingService.embed(query)   // OpenAI API call (~100ms)

3. ANN search (cosine similarity, top-3):
   SELECT ... FROM agent_memories
   WHERE agentType = $agentType
   ORDER BY embedding <=> $vector::vector
   LIMIT 3

4. Format results as context block:
   --- AGENT MEMORY CONTEXT ---
   [REFERENCE 1] (backend / SKILL, score=0.891)
   FILE: src/modules/users/users.service.ts
   ...
   [AVOID 3] (backend / MISTAKE, score=0.843)
   GATE: GATE_2  REJECTION: Missing auth guards
   ...
   --- END MEMORY CONTEXT ---

5. Inject as additional system message (not cached — dynamic content)
```

### Nodes That Read Memories

| Node | agentType queried | Query components |
|------|-------------------|-----------------|
| `ContractNegotiatorNode` | `contract` | projectType + stackKey + complexity + features + companyName |
| `FrontendAgentNode` | `frontend` | projectType + stackKey + techStack.frontend + features + companyName |
| `BackendAgentNode` | `backend` | projectType + stackKey + features + companyName |
| `DatabaseAgentNode` | `database` | projectType + techStack.database + features + companyName |
| `ArchitectureAgentNode` | `architecture` | projectType + stackKey + complexity + companyName |

### Failure Safety
Memory read failures are caught and logged. The agent proceeds with no injected context rather than failing. Memory is advisory — never blocking.

---

## Phase 2D — Skip-Generation Optimization

`MemoryService.findSkipCandidate()` checks if the top-1 SKILL memory for a given agent exceeds a similarity threshold of **0.92** AND matches the current `stackKey`. If both conditions are met, the artifact is reused without an LLM call.

```
1. Query:  query = same query string used in readRelevant
2. Search: top-1 SKILL memory for agentType
3. Check:
   - top.memoryType === 'SKILL'
   - top.similarity >= 0.92
   - top.metadata.stackKey === state.stackKey
4. If all three: return top → skip LLM, use top.content as the artifact
5. Otherwise:   proceed with normal LLM call
```

This threshold (0.92) corresponds to nearly-identical structural content on 1536-dim vectors, not just thematic similarity. It was chosen conservatively to avoid returning semantically-similar but structurally-different artifacts.

### Nodes with Skip-Generation

All five code-generation nodes implement this check (inserted AFTER `readRelevant`, so memory context is still injected if the skip threshold is not met):

- `FrontendAgentNode`
- `BackendAgentNode`
- `DatabaseAgentNode`
- `ArchitectureAgentNode`
- `ContractNegotiatorNode` (via the standard skip-generation path)

When a skip triggers, the node logs:
```
[projectId] Skip-generation: reusing <agent> memory artifact (similarity=0.947)
```
No `EventLog.logCompleted` is called on skip — no tokens were consumed.

---

## Memory Flow Diagram

```
                       ┌────────────────────────────────────────────────────┐
                       │                  DevFlow Run                       │
                       └────────────────────────────────────────────────────┘
                                              │
                                              ▼
                            ┌─────────────────────────────┐
                            │   RequirementsParserNode     │
                            │   (gpt-4o-mini)              │
                            │                              │
                            │  READS:  (none — first node) │
                            │  WRITES: requirements SKILL  │◄─────── Phase 2C new
                            └──────────────┬──────────────┘
                                           │
                                           ▼
                            ┌─────────────────────────────┐
                            │   ContractNegotiatorNode     │
                            │   (claude-sonnet-4-6)        │
                            │                              │
                            │  READS:  contract memories   │
                            │  WRITES: (on gate event)     │
                            └──────────────┬──────────────┘
                                           │  Gate 1 check
                       ┌───────────────────┴───────────────────┐
                       │ complexity=complex?                    │
                       │                                        │
               YES (parallel Send())              NO (sequential)
                       │                                        │
          ┌────────────┼────────────┐               ┌──────────┘
          ▼            ▼            ▼               ▼
   ┌──────────┐ ┌──────────┐ ┌──────────┐   ┌──────────┐
   │ Frontend │ │ Backend  │ │ Database │   │ Frontend │
   │  (haiku) │ │  (haiku) │ │  (haiku) │   │  (haiku) │
   │          │ │          │ │          │   └────┬─────┘
   │ READS:   │ │ READS:   │ │ READS:   │        │
   │ frontend │ │ backend  │ │ database │   ┌────▼─────┐
   │ memories │ │ memories │ │ memories │   │ Backend  │
   └────┬─────┘ └────┬─────┘ └────┬─────┘   │  (haiku) │
        │             │             │         └────┬─────┘
        │        ┌────┘             │              │
        │        │   ┌──────────┐   │         ┌────▼─────┐
        │        │   │Architect │   │         │ Database │
        │        │   │ (sonnet) │   │         │  (haiku) │
        │        │   │          │   │         └────┬─────┘
        │        │   │ READS:   │   │              │
        │        │   │ arch     │   │         ┌────▼─────┐
        │        │   │ memories │   │         │Architect │
        └────────┴───┴──────────┴───┘         │ (sonnet) │
                       │                      └────┬─────┘
                       │  artifacts reducer         │
                       └───────────────────────────┘
                                       │
                                       ▼
                         ┌─────────────────────────┐
                         │     ValidatorNode        │
                         │     (heuristic)          │
                         │                          │
                         │ On failure:              │
                         │  WRITES: MISTAKE per     │◄──── Phase 2C new
                         │  implicated agent        │
                         └──────────────┬───────────┘
                                        │
                                        │  Gate 2 check
                                        │
                       ┌────────────────┼────────────────┐
                       │                                  │
                   REJECTED                           APPROVED
                       │                                  │
                       ▼                                  ▼
            WRITES MISTAKE per artifact      WRITES SKILL per artifact
            (orchestration.service.ts)       WRITES PATTERN for contract
                                             (orchestration.service.ts)
                                                          │
                                                          ▼
                                               GithubCommitNode → DELIVERED
```

---

## Performance Characteristics

| Operation | Latency | Notes |
|-----------|---------|-------|
| embed(query) | ~100ms | Single OpenAI API call |
| ANN search (IVFFlat, 10k rows) | <5ms | In-process Postgres |
| ANN search (HNSW, 100k rows) | <2ms | Rebuild index at 10k rows |
| writeMemory | ~150ms | embed + INSERT |
| findSkipCandidate (hit) | ~105ms | embed + ANN(top-1) |

Memory reads add ~100–150ms to each agent's pre-LLM phase. Against a 2–8 second LLM call, this overhead is negligible.

---

## Operational Notes

### IVFFlat → HNSW Migration
When `agent_memories` row count exceeds 10,000:
```sql
DROP INDEX agent_memories_embedding_ivfflat_idx;
CREATE INDEX agent_memories_embedding_hnsw_idx
  ON agent_memories
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

### Memory TTL
No automatic TTL is implemented. MISTAKE memories older than 90 days can be pruned manually:
```sql
DELETE FROM agent_memories
WHERE "memoryType" = 'MISTAKE' AND "createdAt" < NOW() - INTERVAL '90 days';
```

### Monitoring
The MemoryService logs every write attempt and every read failure. Key log patterns:

```
Memory written: type=SKILL agent=backend project=<uuid>
Memory written: type=PATTERN agent=contract project=global
MemoryService.readRelevant failed for frontend: ... — continuing without memory context
Skip-generation candidate found for architecture/... (similarity=0.943)
[<projectId>] Skip-generation: reusing backend memory artifact (similarity=0.951)
```
