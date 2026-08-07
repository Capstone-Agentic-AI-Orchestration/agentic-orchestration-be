# Orchestration scope

Status: active. Describes a deliberate constraint, not a limitation to work around.

## The rule

**Orchestration runs inside a project. There is no way to run an agent outside one, and that is
intentional for now.**

Every dispatch is anchored to a `projectId`. An agent cannot be invoked from the workspace level,
from the Agents page, or from a chat box. If you want work done, it happens against a project.

## Why the constraint exists

A project is what supplies the things an agent needs in order to be safe and useful:

| Provided by the project | Without it |
|---|---|
| `groupId` → which workspace's agents and skills apply | no way to resolve an agent's configuration |
| a repository and a scoped `repoToken` | tools have nothing to read or write, safely |
| a locked contract and acceptance criteria | nothing to validate output against |
| gates and a delivery review | no human checkpoint before code is committed |
| membership | no basis to authorise the caller |

An agent running outside a project is a model with repository write access and no contract to
check it against. The constraint is what makes the pipeline verifiable.

## Where the scope is enforced today

This is not enforced in one place; it falls out of the data model. Each of these would have to be
addressed to relax it:

| Enforcement point | Mechanism |
|---|---|
| `resolveAgentSystemPrompt(prisma, projectId, …)` | resolves `groupId` **through** the project; no project, no configuration |
| `ProviderInvocation.projectId` | all telemetry — runs, last-active, working — is counted per project |
| `AgentsService.activityByKey` | scopes invocations by `project: { groupId }` |
| `WorkOrder.projectId` (non-null) | work orders cannot exist without a project |
| `OrchestrationRun.projectId` (non-null) | a run *is* a project run |
| `/internal/agent-repo/*` | authorises against a per-turn token bound to a project's repository |
| `DevFlowState.projectId` | the graph state is seeded from a project |

The Agents console page is therefore **configuration only**. It shows what an agent is and what
it has done; it offers no way to invoke one. That is correct and should not be "fixed" by adding
a run button to it.

## What would have to change to run outside a project

Recorded so the eventual implementation does not have to rediscover it. Roughly in dependency
order:

1. **A scope other than a project.** Something has to supply `groupId` and an authorisation
   context. The natural candidate is the workspace itself, which already owns agents, skills,
   clients and repositories.
2. **A repository binding that is not a project's.** `agent-repo` issues per-turn tokens scoped
   to a project's repository. Workspace-level work needs either a designated repository or a
   sandbox with no repository at all — and the tool set differs between those two cases.
3. **`ProviderInvocation.projectId` becomes nullable**, with a `groupId` column added. Every
   activity query in `AgentsService` currently reaches through `project` and would need to accept
   either anchor. This is the change with the widest blast radius.
4. **A contract substitute.** Pipeline runs validate against a locked contract. Ad-hoc work has
   none, so either validation is skipped — which must be an explicit, visible state, not a
   silent one — or a lighter acceptance check replaces it.
5. **A dispatch entry point.** Work orders are the natural vehicle and already model status,
   dispatch and retry, but `WorkOrder.projectId` is non-null, so this depends on (1) and (3).

## Design rules to keep in the meantime

So that relaxing the constraint later is a change of scope rather than a rewrite:

- **Do not hardcode `projectId` as the only anchor in new code.** Where a function needs a
  workspace, take `groupId` and let the caller resolve it, rather than taking `projectId` and
  reaching through the project. `resolveAgentSystemPrompt` currently does the latter; it is a
  known compromise, documented here so it is found again.
- **Keep agent configuration workspace-scoped, never project-scoped.** Agents and skills belong
  to a workspace and are already stored that way. If they had been scoped to a project, running
  outside one would be impossible without a migration.
- **Keep pipeline roles and assignable workers separate.** See
  [agent-platform.md](agent-platform.md#two-kinds-of-agent). The closed pipeline set is what stays
  project-bound. Assignable workers are what would eventually run at workspace level.

## Related

- [agent-platform.md](agent-platform.md) — how agents are stored and dispatched
- [roadmap/agent-platform.md](../roadmap/agent-platform.md)
