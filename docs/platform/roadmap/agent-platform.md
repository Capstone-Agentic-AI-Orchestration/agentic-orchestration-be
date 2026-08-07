# Agent platform roadmap

Status: active. Updated as steps land.

Sequenced work to finish the agent platform. Steps 1–3 fix things that are broken or misleading
today; 4–5 are the architectural move; 6–7 complete it.

| # | Step | Schema | Deploy | Status |
|---|---|---|---|---|
| 1 | `npm install` + `eve deploy` the agent package | no | **yes** | **blocked — needs an operator** |
| 2 | Sync the roster from `/eve/v1/info`, add `runtimeMissing` | small | no | done |
| 3 | Wire the remaining built-in agents to the prompt resolver | no | no | done |
| 4 | Two runtimes + `runtimeKey` | small | yes, once | **code done, deploy pending** |
| 5 | Dynamic skill resolver | no | yes, once | not started |
| 6 | Work order → agent FK, agent-shaped prompt, picker | yes | no | done |
| 7 | Snapshot prompt hash per invocation | small | no | done (pipeline only) |

---

## 1. Redeploy the agent package — blocked, needs an operator

**This is a stale deployment, not missing code.** See
[operations/agent-package-redeploy.md](../operations/agent-package-redeploy.md) for the runbook.

`GET /eve/v1/info` reports **8** subagents. The repository has **12**, and all twelve are
committed and pushed:

```
qa, security-review, integration-reviewer, planner-orchestrator
  → tracked, committed in c83fc52 (2026-07-27), which is origin/main with 0 commits ahead
```

So the live build predates that commit. Three dispatch paths target subagents the deployed
service does not have:

| Node | Dispatches | Deployed |
|---|---|---|
| `contract-negotiator.node.ts` | `subagent: 'planner-orchestrator'` | no |
| `quality-review.node.ts` | `subagent: 'qa'` / `'security-review'` | no |
| `self-critique.node.ts` | `subagent: 'integration-reviewer'` | no |

With `ORCHESTRATION_LLM_ENGINE="eve"` these fail at run time, so contract negotiation, QA review,
security review and integration review are all affected.

Worth diagnosing rather than only fixing: if the Vercel project is git-connected, the push on
27 July should have deployed automatically. Either it is not connected, or a build failed
unnoticed. A redeploy fixes today; knowing which stops it recurring.

## 2. Sync the roster from the deployed manifest — done

`EveRuntimeCatalogService` reads `GET /eve/v1/info` (60s cache, 5s timeout) and is now the
seeding authority. `BUILT_IN_AGENTS` remains only as the fallback when Eve is unreachable, and as
the source of display names and avatars for keys it recognises.

The list that drifted was written *from the package source* and documented at the time as "a
mirror, not a feed — nothing will fail loudly on drift". The drift was already present when it was
written: it claims twelve agents, eight can run. Reading the deployed manifest makes that
detectable instead of invisible.

Built-ins with no deployed runtime carry `runtimeMissing: true` and render as **No runtime** in
the roster, with an explanatory banner on the detail page.

**`null` and empty are different.** When Eve cannot be reached the catalog returns `null`, which
means "unknown" and suppresses the annotation entirely. Treating unreachable as "nothing is
deployed" would paint every agent as broken during a transient outage.

## 3. Wire the remaining built-ins — done (10 of 12; the other 2 are unreachable)

Only five nodes read workspace instructions; every other agent's Instructions field was editable
and inert. Ten keys now resolve through `resolveAgentSystemPrompt`:

| Node | Agent key |
|---|---|
| `frontend-agent` | `frontend` |
| `backend-agent` | `backend` |
| `database-agent` | `database` |
| `architecture-agent` | `architecture` |
| `mobile-agent` | `mobile` |
| `contract-negotiator` | `planner-orchestrator` |
| `requirements-parser` | `requirements-parser` |
| `quality-review` | `qa`, `security-review` |
| `self-critique` | `integration-reviewer` |

`quality-review` assembled its prompts inline, so `QA_REVIEW_SYSTEM` and
`SECURITY_REVIEW_SYSTEM` were extracted into `agent-prompts.ts` first. Its JSON output contract
was extracted separately as `REVIEW_OUTPUT_CONTRACT` and is appended **after** the workspace's
instructions, so a workspace cannot replace the shape every caller parses.

Two roster entries remain unwired because **no node dispatches them by name**:

- `contract-negotiator` — the node of that name dispatches `planner-orchestrator`
- `self-critique` — the node of that name dispatches `integration-reviewer`

They are aliases in the roster, not separate runtimes. They should disappear when step 4
collapses the roster onto real runtimes; until then their Instructions field has no effect and
the console should say so.

## 4. Two runtimes instead of twelve — code done, deploy pending

**Landed:**

- `WorkspaceAgent.runtimeKey`, nullable, meaning "same as `key`" — so every existing row keeps
  dispatching exactly as before with no backfill.
- `generic-builder` and `generic-reviewer` authored in the package. The builder re-exports the
  same four shared tools; the reviewer has none, deliberately — a reviewer that can write to the
  repository is not a reviewer. Both `instructions.md` carry only the invariant part (the loop,
  the tool contract, the output shape) and state explicitly that the role arrives in the message.
- `GET /agents/runtimes` returns the capability profiles annotated with `deployed`, so the
  console can offer an option that will not work yet rather than hide it unexplained.
- The create-agent form has a Runtime picker; a not-yet-deployed choice is labelled and warned
  about rather than silently accepted.
- `runtimeMissing` now checks the **runtime**, not the identity — a custom agent on
  `generic-builder` is correctly flagged while that runtime is undeployed.
- Built-ins refuse a `runtimeKey` change: the pipeline dispatches them by key, so repointing one
  would silently change what executes a contractual role.

**Still pending:**

- The deploy, which is what makes `generic-builder` / `generic-reviewer` real. Until then a
  custom agent is created and correctly shows **No runtime**.
- Collapsing the twelve existing directories down to the two. Deliberately not done in the same
  change: the pipeline still dispatches built-ins by their own key, so deleting those directories
  before the nodes are repointed would break every run. Sequence it after step 6.
- Model precedence (`agent.model → run override → default`). `agent.model` is still stored and
  not read.

### Original analysis



The twelve subagent directories are two capabilities in disguise:

- **five builders** (frontend, backend, database, architecture, mobile) whose twenty tool files
  are identical re-exports of one shared implementation, differing only in a comment naming the
  subagent
- **seven reviewers** with no tools at all

The only genuine per-directory difference left is the prose in `instructions.md`, which the
database now owns.

Replace them with `generic-builder` and `generic-reviewer`, whose instructions carry only the
invariant part — the tool loop and the output contract — and defer the role to the message. Add
`WorkspaceAgent.runtimeKey` to name which runtime executes an agent; built-ins keep
`runtimeKey === key`.

After this, **adding an agent never requires a deploy.**

Also fold in model precedence, which is currently stored but not read:
`agent.model → run override → default`.

## 5. Dynamic skill resolver — not started

Eve supports `defineDynamic` resolvers that run at message time, materialise skills into the
sandbox as files, and announce them to the model. A resolver in `agent/skills/` that fetches the
workspace's skills from the control plane replaces prompt concatenation. One deploy, after which
skills are pure data.

## 6. Work orders dispatch agents — partly done

**Correction to an earlier claim in this document.** It previously said work-order dispatch
"never calls a model" and that the path was unbuilt. That was wrong, inferred from
`WORK_ORDER_AGENT_SYSTEM` being unreferenced. `dispatchWorkOrder` calls
`orchestration.executeWorkOrder`, which calls `provider.generateWorkOrderOutput` and validates
the artifact. The constant is unused because the provider assembles its own prompt.

**Landed:**

- `WorkOrder.workspaceAgentId`, nullable — null preserves the previous behaviour exactly, so no
  backfill and no change to existing work orders.
- `agentType` stays required and keeps its meaning: it is the **output contract** — required
  extensions, language, and the signals the validator checks. The agent is *who does the work*.
  Orthogonal questions, so both are stored.
- `executeWorkOrder` resolves the assigned agent's effective prompt — its own instructions plus
  attached skills, or the built-in fallback — and passes it on the context.
- The provider substitutes that for the `agentType`-derived role, positioned **after** the JSON
  output schema and before the quality bar, so a workspace can define how its agent works and
  cannot replace the shape the validator parses. `work-order-agent-prompt.spec.ts` pins that
  ordering rather than the wording.

**Known limitation — work orders never reach Eve.**

`LlmAgentProvider extends BaseLlmProvider`: the direct provider. Pipeline nodes route through
`AgentLlmRouter`, which can select Eve; work orders do not. So a work-order agent:

- gets its instructions and skills — **real today**
- does **not** get repository tools or the typecheck self-repair loop, because those live in the
  Eve sandbox
- carries a `runtimeKey` that is currently informational, since the direct path has no subagent

Assigning a `generic-builder` agent to a work order therefore does not grant it repository
access. Routing work orders through `AgentLlmRouter` is the follow-up that would, and it is a
separate change with its own risk: work orders would gain tools, a sandbox, and a different
failure surface.

**Console:** the work-order form now has an **Assign to agent** picker, separate from **Output
type**. Unassigned is the default and keeps the previous behaviour, so the choice is additive and
never forced. Agents whose runtime is not deployed appear but are disabled, rather than being
offered and then failing.

## 7. Snapshot what ran — done for pipeline dispatches

`ProviderInvocation` gained `promptHash` (SHA-256 of the exact system prompt sent) and
`promptChars`. Computed in `AgentLlmRouter.generateJson`, which is the only point where a fully
assembled prompt and the invocation record meet — each node builds its prompt independently and
none of them know the invocation id, which is created there.

A hash rather than the text: the assembled prompt carries the contract, retrieved memory and
prior feedback, so storing it per invocation would dwarf every other column. The hash answers
what is actually asked — did the prompt change between these two runs, which runs shared one —
and the length makes prompt bloat visible.

`prompt-fingerprint.spec.ts` pins the properties that matter: stability, and sensitivity to any
change including whitespace and case. A fingerprint that trimmed or normalised would quietly
hide real edits, which is the opposite of the point.

**Known gap — work orders are not fingerprinted.**

Only `AgentLlmRouter` starts invocations, and work orders bypass it: `LlmAgentProvider` extends
`BaseLlmProvider` directly. Two consequences, both worth knowing before trusting the numbers:

- work-order dispatches have no `promptHash`
- **work-order dispatches do not appear in `ProviderInvocation` at all**, so the Agents page's
  Runs, Last active and Working counts reflect pipeline dispatches only

Closing both is the same change as the step 6 follow-up: routing work orders through
`AgentLlmRouter`. Until then the console's activity numbers are accurate about what they measure
and silent about what they omit.
