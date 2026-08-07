# Agent platform

Status: target. Sections marked **Not built** describe intent, not current behaviour.

How an agent is stored, configured and dispatched across the three repositories.

## The problem this solves

The console's agent roster began as a hand-maintained TypeScript constant mirroring
`agentic-orchestration-ag/agent/subagents/`. It could drift from the package without anything
failing, and nothing on the page could be changed. Making it editable raised a question that had
never been answered: **what part of an agent is code, and what part is data?**

## Three planes

| Plane | Lives in | Owns | Changes by |
|---|---|---|---|
| **Capability** | `agentic-orchestration-ag`, git | tools, sandbox, self-repair loop, output contract | `eve deploy` |
| **Configuration** | Supabase, `orchestration` schema | identity, instructions, skills, model, concurrency, access | a console save |
| **Execution** | per run | the resolved prompt, skills and model actually used | automatic, at dispatch |

The dividing line is not arbitrary. A capability is executable code that runs in a sandbox with
repository write access. Configuration is text.

### Capabilities cannot be authored from the console

There is no "create a tool" feature and there should not be one. A UI that lets a user define a
tool is a remote-code-execution feature with a friendly icon. Capabilities ship through git,
review and a deploy. The console picks from what is deployed.

This is why the reference products this console is modelled on show a **Runtime** column: the
agent is the configuration, the runtime is the capability it borrows.

### Why the execution plane has no database

`agentic-orchestration-ag` declares two dependencies (`eve`, `zod`) and reads four environment
variables: `DEVFLOW_API_URL`, `AGENT_REPO_SERVICE_TOKEN`, `EVE_SERVICE_TOKEN`,
`EVE_ALLOW_LOCAL_DEV_AUTH`. No `DATABASE_URL`, no Supabase client.

Every repository read or write an agent performs is a call back to
`POST {DEVFLOW_API_URL}/internal/agent-repo/*`, authenticated by a shared service secret and a
per-turn token, authorised and scoped by the control plane. If the package held a database
credential, that boundary would collapse into "the code-generating model has direct database
access".

## How a dispatch resolves

```
node (e.g. frontend_agent)
  └─ resolveAgentSystemPrompt(prisma, projectId, 'frontend', FRONTEND_AGENT_SYSTEM)
       ├─ project.groupId                      → which workspace
       ├─ workspace_agents(groupId, key)       → instructions ?? built-in prompt
       └─ + attached skills                    → appended under "## Skills"
  └─ buildAgentSystemPrompt({ basePrompt, memory, contract, feedback, ... })
  └─ POST {EVE_SERVICE_URL}/eve/v1/session { agent: <runtime>, message }
                                               ↑ deployed  ↑ the whole prompt
```

The `agent` field of an Eve session is a **deployed directory name**, not an identity. The prompt
travels in `message`. That is what allows the database to own the prompt without a deploy, and it
is why editing a built-in agent's instructions already takes effect on the next run.

Every failure path in `resolveAgentSystemPrompt` returns the built-in prompt. A misconfigured or
unreachable agent row degrades a run to default behaviour; it never stops one.

## Data model

`orchestration.workspace_agents` — one row per agent per workspace.

| Column | Notes |
|---|---|
| `key` | dispatch identity, unique per `groupId` |
| `instructions` | **nullable**. Null means "use the built-in prompt" |
| `model`, `concurrency` | stored; see Roadmap for wiring status |
| `accessScope` | `WORKSPACE` or `PERSONAL` |
| `isBuiltIn` | seeded from the package; archivable, never deletable |
| `groupId` | the owning workspace |

`orchestration.agent_skills` — workspace-global Markdown, authored once, attached to many agents
via `agent_skill_on_agent`.

### Why `instructions` is nullable rather than seeded with a copy

Seeding each row with a copy of the built-in prompt would freeze it at seed time and silently
diverge from the package every time a built-in prompt is improved. Null means "track the
package". The console shows the current built-in in a disclosure so an author can read what they
are about to override, and "Reset to built-in" clears the column rather than pasting the text
back in.

### Why built-in agents archive instead of deleting

Runs dispatch built-ins by key. Deleting the row would not tidy the roster; it would leave a run
resolving a prompt for an agent that no longer exists. Archiving takes it off the active list and
keeps the key resolvable. Custom agents delete normally.

## Keeping the roster in sync

There are three lists of agents and they can disagree:

1. `agent/subagents/` in the package — source code
2. the **deployed** Eve service — what can actually run
3. `workspace_agents` in Supabase — identity and configuration

`GET /eve/v1/info` (authenticated with `EVE_SERVICE_TOKEN`) returns a live manifest of every
deployed subagent with its name, description and tool count. **That manifest is the authority on
capability**, and the control plane should reconcile against it rather than maintain a fourth
hand-written copy.

| Reconciliation | Outcome |
|---|---|
| deployed, no row | seed the row |
| row, not deployed | mark the agent `runtimeMissing`, surface it in the console, refuse to dispatch with a clear error |
| both | healthy |

The `row, not deployed` state is not hypothetical. It has already occurred — see the roadmap.

## Skills

A skill is a Markdown document owned by the workspace, authored once and attachable to many
agents. Duplicating the text per agent guarantees the copies drift.

**Today** skills are appended to the resolved system prompt under a `## Skills` heading. This
works with no package change but sends the text on every call.

**Not built** — the target is Eve's dynamic skill resolver: a `defineDynamic` handler in
`agent/skills/` that fetches the workspace's skills from the control plane per session and lets
Eve materialise them into the sandbox as files. One deploy, after which skills are pure data.

### Skills must not be able to break the output contract

Every agent node parses strict JSON. A skill saying "always explain your reasoning first" would
break every run the agent touches. Skills are injected into **role guidance only**; the
output-shape instructions are assembled after them and are not overridable. Without that
ordering, a text box in the console becomes a way to break the pipeline.

## Two kinds of agent

This distinction is the one most easily lost, and losing it makes the orchestration
unverifiable.

| | Pipeline role | Assignable worker |
|---|---|---|
| Example | `frontend`, `qa`, `security` | a user-created "UI Developer" |
| Selected by | the planner, into `contract.agentPlan.activeAgents` | a human, via a work order |
| Set of roles | **closed** — the 8-value `PlannedAgent` union | open |
| Runs in | the Gate 1 → Gate 2 fan-out | ad-hoc, outside the graph |

`PlannedAgent`'s eight roles are what the validator's retry map, `codeAgentsFor()` and the
domain-contract checks key off. Making that set dynamic makes a run impossible to verify. Custom
agents therefore belong on **work orders**, which already model status, dispatch, execution and
retry, and which the console already surfaces as the Agents lane of the issue board.

## Reproducibility

**Not built.** `ProviderInvocation` records the model used but not the prompt. The moment
instructions are editable, past runs become unexplainable: the prompt that produced an artifact
may since have been rewritten. A prompt hash and the attached skill ids, recorded per invocation,
keeps runs auditable. This is cheap to add now and archaeology later.

## Workspace ownership is a database invariant

`Client.groupId` is **NOT NULL**. A client always belongs to exactly one workspace, and the
"unassigned" state no longer exists.

It briefly did. The migration that introduced the column backfilled it by inferring a workspace
from each client's projects and deliberately left clients with no projects unset, rather than
attaching a real company to an arbitrary team. That was the right call for a backfill and the
wrong one to keep: every read path then had to special-case it — an `OR groupId IS NULL` clause
so orphans stayed visible, a console badge, a fallback on the Projects page. All of it existed to
handle a row that should not have been creatable.

The invariant is enforced in three places, deliberately:

| Layer | Enforcement |
|---|---|
| Database | `NOT NULL`, verified by a probe insert failing with `23502` |
| DTO | `groupId` is required on client creation, and on inquiry approval |
| Console | the New client button is disabled without an active workspace |

**Inquiry approval was the source of orphans.** It creates both a client *and* a project, and
carried a workspace for neither — so an approved lead produced a client the switcher could not
show and a project every workspace filtered out. `ReviewInquiryDto` now requires `groupId` and
applies it to both.

Moving a client between workspaces is supported; clearing is not. An empty `groupId` on update is
ignored rather than mapped to null.

## Related

- [client-lifecycle.md](client-lifecycle.md) — the other half of inquiry approval: the project it
  creates is a discovery space, not delivery work
- [orchestration-scope.md](orchestration-scope.md) — orchestration is project-scoped
- [roadmap/agent-platform.md](../roadmap/agent-platform.md) — what is done and what is not
- [EVE_MIGRATION.md](../../architecture/EVE_MIGRATION.md) — the hybrid delegation strategy
