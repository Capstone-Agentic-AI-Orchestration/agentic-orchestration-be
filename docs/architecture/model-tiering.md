# Model Tiering — Design Document

> Phase 2D implementation. All model constants are live in the respective node files.

## Rationale

Not all nodes in the pipeline benefit equally from a more capable model. Using Sonnet uniformly across the pipeline would triple LLM costs per run without a proportional improvement in output quality. The tiering strategy concentrates higher-capability models at nodes where reasoning quality has a material, measurable downstream effect.

Two nodes are elevated to Sonnet in Phase 2D:

1. **ContractNegotiatorNode** — The contract's `fileManifest` and `acceptanceCriteria` propagate to every downstream agent. A poor contract (ambiguous criteria, missing files) causes validator failures and triggers 2–3 retry cycles across haiku agents, each retry costing ~$0.005. One good Sonnet contract prevents those retries; the upgrade pays for itself in a single retry-avoided scenario.

2. **ArchitectureAgentNode** — The three architecture documents (ARCHITECTURE.md, API.md, DEPLOYMENT.md) are the primary deliverables reviewed by capstone panel evaluators and are human-audited at Gate 2. Code generation outputs (frontend/backend/database) are validated structurally by the heuristic ValidatorNode; architecture docs are evaluated qualitatively. Sonnet produces more accurate Mermaid diagrams, complete OpenAPI schemas, and deployable runbooks.

---

## Tiering Table

| Node | Model | Reasoning |
|------|-------|-----------|
| `parse_requirements` | `gpt-4o-mini` | Structured extraction from a prompt — mini is sufficient; schema-constrained output removes reasoning risk |
| `negotiate_contract` | `claude-sonnet-4-6` | Contract quality determines ALL downstream artifact quality; see rationale above |
| `frontend_agent` | `claude-haiku-4-5` | Code generation — haiku is fast and cost-effective; output validated structurally |
| `backend_agent` | `claude-haiku-4-5` | Same as frontend |
| `database_agent` | `claude-haiku-4-5` | Same as frontend; Prisma schema validated by ValidatorNode |
| `architecture_agent` | `claude-sonnet-4-6` | Architecture docs are human-reviewed at Gate 2; see rationale above |
| `validate_outputs` | (no LLM — heuristic) | Rule-based brace balancing, import checks, Prisma model validation |
| `commit_to_github` | (no LLM) | GitHub API calls only |

---

## Pricing Reference (as of April 2026)

| Model | Input ($/M tokens) | Output ($/M tokens) | Cache hit input ($/M tokens) |
|-------|--------------------|---------------------|------------------------------|
| gpt-4o-mini | $0.15 | $0.60 | ~$0.075 (50% discount) |
| claude-haiku-4-5 | $0.80 | $4.00 | $0.08 (cache_control: ephemeral) |
| claude-sonnet-4-6 | $3.00 | $15.00 | $0.30 (cache_control: ephemeral) |

---

## Cost Model per Run

### Assumptions
- Complex project (complexity = 'complex')
- ~15 files in the fileManifest
- No skip-generation hits (cold start)
- Parallel execution path (Phase 2D: all four code agents run simultaneously)
- Prompt caching effective: static system prompts (~500 tokens each) are cache-hit after first call in the session

### Per-Node Cost Breakdown

| Node | Model | Est. input tokens | Est. output tokens | Cache-hit input tokens | Cold cost | Warm cost (cache hit on system prompt) |
|------|-------|------------------|--------------------|------------------------|-----------|---------------------------------------|
| `parse_requirements` | gpt-4o-mini | 2,000 | 500 | 500 | $0.00060 | $0.00056 |
| `negotiate_contract` | claude-sonnet-4-6 | 3,500 | 2,000 | 500 | $0.0405 | $0.0396 |
| `frontend_agent` | claude-haiku-4-5 | 5,000 | 8,000 | 500 | $0.0360 | $0.0356 |
| `backend_agent` | claude-haiku-4-5 | 5,000 | 8,000 | 500 | $0.0360 | $0.0356 |
| `database_agent` | claude-haiku-4-5 | 3,000 | 5,000 | 500 | $0.0224 | $0.0220 |
| `architecture_agent` | claude-sonnet-4-6 | 6,500 | 6,000 | 500 | $0.1095 | $0.1086 |
| **Total (tiered, cold)** | | | | | **~$0.145** | |
| **Total (tiered, warm)** | | | | | | **~$0.141** |

### Comparison: Haiku-Only Baseline

| Node | Model | Est. input tokens | Est. output tokens | Cold cost |
|------|-------|------------------|--------------------|-----------|
| `parse_requirements` | gpt-4o-mini | 2,000 | 500 | $0.00060 |
| `negotiate_contract` | claude-haiku-4-5 | 3,500 | 2,000 | $0.0108 |
| `frontend_agent` | claude-haiku-4-5 | 5,000 | 8,000 | $0.0360 |
| `backend_agent` | claude-haiku-4-5 | 5,000 | 8,000 | $0.0360 |
| `database_agent` | claude-haiku-4-5 | 3,000 | 5,000 | $0.0224 |
| `architecture_agent` | claude-haiku-4-5 | 6,500 | 6,000 | $0.0292 |
| **Total (haiku-only)** | | | | **~$0.115** |

The tiered configuration adds ~$0.030 per complex run (~26% increase) in exchange for:
- A contract that is measurably better-structured → fewer validator retries
- Architecture documentation that passes Gate 2 human review without revision

A single avoided retry cycle (one haiku re-run of backend_agent) saves ~$0.036, making the Sonnet upgrade cost-neutral on average.

---

## Prompt Caching Savings

All static system prompts across all five LLM-calling nodes use `cache_control: { type: 'ephemeral' }`. This caches the system prompt for 5 minutes within the same Anthropic API session.

### Savings per Node (system prompt ~500 tokens)

| Model | Full input cost (500 tokens) | Cache hit cost (500 tokens) | Savings per hit |
|-------|-----------------------------|-----------------------------|-----------------|
| claude-haiku-4-5 | $0.00040 | $0.000040 | $0.000360 |
| claude-sonnet-4-6 | $0.00150 | $0.000150 | $0.001350 |

### Parallel Execution Amplification (Phase 2D)

When `complexity = 'complex'`, the graph dispatches frontend, backend, database, and architecture agents in parallel via `Send()`. All four agents are invoked within the same 5-minute cache TTL window, so their system prompts are all cache-hit after the first call in the batch.

For a batch of 10 complex projects run sequentially:
- System prompt tokens saved: 4 agents × 500 tokens × 9 cache hits = 18,000 tokens/batch
- Haiku savings: 18,000 × ($0.80 - $0.08) / 1,000,000 = **$0.013/batch**
- Sonnet savings (architecture): 500 × 9 × ($3.00 - $0.30) / 1,000,000 = **$0.012/batch**
- Combined caching savings: ~**$0.025/batch** (~17% of total haiku spend)

The caching benefit is modest per run but compounds at consultancy-scale (50+ projects/day).

---

## Skip-Generation Savings

When `MemoryService.findSkipCandidate()` returns a hit (similarity >= 0.92, same stackKey), the code-generation node skips the LLM call entirely. Per-skip cost:

| Item | Cost |
|------|------|
| `EmbeddingService.embed(query)` | ~$0.000002 (100 tokens @ text-embedding-3-small) |
| LLM tokens consumed | $0.00 |
| Total per skip | **~$0.000002** |

vs. a normal haiku code-gen call (~$0.036).

### Expected Skip Rate at Steady State

The memory store reaches steady state after ~50 DELIVERED projects of similar type. At steady state, for a consultancy running 5+ projects per stack key:

| Stack pattern | Expected skip rate | Cost per skipped file |
|---------------|-------------------|-----------------------|
| nextjs-nestjs-postgres | 40–60% | $0.000002 |
| react-express-mongodb | 30–50% | $0.000002 |
| vue-fastapi-postgres | 20–40% | $0.000002 |

Assuming 8 code files per complex project and a 50% skip rate at steady state:
- Files skipped: 4 per run
- Haiku cost avoided: 4 × $0.036 = **$0.144 saved per run**
- This more than offsets the entire Sonnet tiering premium ($0.030 per run)

---

## Implementation Pattern

Each node defines its model as a named constant at the top of the file, with a comment explaining the tiering rationale:

```typescript
// contract-negotiator.node.ts
/**
 * ContractNegotiator uses claude-sonnet-4-6 (Phase 2D model tiering decision).
 * Rationale: contract quality determines ALL downstream artifact quality.
 * ...
 */
const CONTRACT_MODEL = 'claude-sonnet-4-6';

// architecture-agent.node.ts
/**
 * Architecture agent uses claude-sonnet-4-6 (Phase 2D model tiering decision).
 * Rationale: architecture docs require higher reasoning quality ...
 */
const ARCHITECTURE_MODEL = 'claude-sonnet-4-6';
```

The model constant is passed directly to `eventLog.logCompleted()` so cost attribution in `RunSupervisorService` is accurate per node.

---

## Summary Table

| Optimization | Mechanism | Savings estimate (per 10 complex runs) |
|-------------|-----------|---------------------------------------|
| Prompt caching (haiku nodes) | `cache_control: ephemeral` on system prompts | ~$0.013 |
| Prompt caching (sonnet nodes) | `cache_control: ephemeral` on system prompts | ~$0.012 |
| Skip-generation (50% hit rate, steady state) | `findSkipCandidate()` threshold 0.92 | ~$1.44 |
| Retry reduction (Sonnet contract quality) | Fewer validator failures | ~$0.36 (1 avoided retry/run) |
| **Combined saving (steady state)** | | **~$1.83 per 10 complex runs** |
