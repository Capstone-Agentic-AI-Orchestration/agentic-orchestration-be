# DevFlow Phase 2 — System Architecture Overview

## Context

DevFlow is an AI-powered code generation orchestration backend built for Alphaexplora, a 12-person Philippine IT consultancy. It accepts project briefs, orchestrates a multi-agent LangGraph pipeline to generate full-stack codebases, routes the output through two human-in-the-loop approval gates, and commits approved code to a GitHub organization.

Phase 1 delivered the core pipeline. Phase 2 adds four capability layers on top of Phase 1's foundation without replacing any existing infrastructure.

---

## Phase 2 Milestones

| Milestone | Capability | Status |
|-----------|-----------|--------|
| 2A | Memory Foundation (pgvector, AgentMemory, MemoryService) | Complete |
| 2B | Run Supervisor (stuck detection, retry budget, EventLog) | Pending |
| 2C | Skills/Mistakes/Patterns Recording (gate-driven write-back) | Integrated into 2A |
| 2D | Parallel Execution + Model Tiering | Pending |
| 2E | Frontend Dashboard + WebSocket + LangSmith | Pending |

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         HTTP API (NestJS)                        │
│  POST /projects  ·  GET /projects/:id/status                    │
│  POST /projects/:id/gate-1  ·  POST /projects/:id/gate-2        │
└────────────────────────────┬────────────────────────────────────┘
                             │ fire-and-forget
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    LangGraph StateGraph                          │
│                                                                  │
│  parse_requirements ──► negotiate_contract ──► [GATE 1]         │
│                                                     │           │
│                                               ┌─────▼──────┐   │
│                                               │ frontend   │   │
│                                               │ backend    │◄──┤ (parallel
│                                               │ database   │   │  in 2D)
│                                               │ architecture│  │
│                                               └─────┬──────┘   │
│                                                     │           │
│                                           validate_outputs      │
│                                                     │           │
│                                               [GATE 2]          │
│                                                     │           │
│                                           commit_to_github      │
│                                                     │           │
│                                           mark_delivered        │
└─────────────────────────────────────────────────────────────────┘
              │ reads/writes                        │ checkpoints
              ▼                                     ▼
┌─────────────────────────┐          ┌──────────────────────────┐
│  PostgreSQL 16           │          │  PostgreSQL 16            │
│  (pgvector extension)   │          │  (LangGraph checkpoints)  │
│                         │          │                           │
│  Project                │          │  checkpoints              │
│  GateEvent              │          │  checkpoint_writes        │
│  Artifact               │          │  checkpoint_blobs         │
│  AgentMemory ← Phase 2A │          │  checkpoint_migrations    │
│  EventLog    ← Phase 2B │          └──────────────────────────┘
│  RunBudget   ← Phase 2B │
└─────────────────────────┘
```

All tables live in the same `devflow` database — no new infrastructure.

---

## Phase 2A — Memory Foundation Detail

Each agent node now follows this execution pattern:

```
before execute():
  1. Build a memory query from: projectType + stackKey + features
  2. Call MemoryService.readRelevant(agentType, query, topK=3)
  3. Embed query via text-embedding-3-small (EmbeddingService)
  4. ANN search against agent_memories via IVFFlat cosine index
  5. Format top-3 as context block → inject into system prompt

execute():
  6. Call Anthropic API with cache_control: ephemeral on static system prompt
  7. Return artifacts

on Gate 1 REJECTED:
  8. Write MISTAKE memory: rejected contract + rejection notes

on Gate 2 REJECTED:
  9. Write MISTAKE memory per artifact + rejection notes

on Gate 2 APPROVED:
  10. Write SKILL memory per artifact (content + filePath + stack)
  11. Write PATTERN memory for the successful contract
```

---

## Key Design Decisions

### Same PostgreSQL Instance
Cost constraint drives this. pgvector is an extension on the existing `devflow` Postgres 16 container (image swapped to `pgvector/pgvector:pg16`). No new DB instance means zero additional infrastructure cost.

### Write-on-Gate-2-Approval Only (Option A)
SKILL and PATTERN memories are only written when the human reviewer approves Gate 2. This prevents the memory store from accumulating low-quality patterns from incomplete or rejected runs. MISTAKE memories are the exception — they write on rejection to proactively prevent future repetitions.

### Anthropic Prompt Caching
All static system prompts use `cache_control: { type: 'ephemeral' }`. Cache hits cost 0.1× the input token price. This is mandatory across every agent node for cost efficiency.

### text-embedding-3-small
1536-dim vectors at $0.02/1M tokens. Chosen over text-embedding-3-large ($0.13/1M tokens) because the embedding quality difference is immaterial for code/artifact similarity at this scale.

### IVFFlat Index
Development uses `lists=10` (IVFFlat). Rebuild with HNSW (`m=16, ef_construction=64`) when row count exceeds 10,000 — HNSW is faster at query time but slower to build and uses more memory.

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20, TypeScript strict mode |
| Framework | NestJS 10 |
| Graph engine | LangGraph JS 0.2 |
| Checkpointing | PostgresSaver (langgraph-checkpoint-postgres) |
| App ORM | Prisma 5 |
| Vector search | pgvector (Postgres extension) |
| LLM — codegen | claude-haiku-4-5 |
| LLM — contract/arch | claude-haiku-4-5 (sonnet in Phase 2D) |
| LLM — requirements | gpt-4o-mini |
| Embeddings | text-embedding-3-small (1536-dim) |
| Tests | Vitest |
| Container | Docker Compose |
