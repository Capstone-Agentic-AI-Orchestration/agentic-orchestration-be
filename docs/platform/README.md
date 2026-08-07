# DevFlow platform documentation

Cross-repository architecture: decisions that no single repository can own because they span the
control plane, the execution plane and the console.

**Where this lives.** These documents describe four repositories but are versioned in
`agentic-orchestration-be`, because the control plane is where every one of these decisions is
enforced — the schema, the boundaries, the dispatch. A separate docs repository would drift from
the code that has to honour it, and it would have no CI to notice.

Documentation about the backend *itself* — its deployment, its API, its internal architecture —
stays in `docs/architecture`, `docs/api` and `docs/setup` alongside this folder. Everything here
is about the system, not the service.

## Repositories

| Repo | Role | Holds a database credential |
|---|---|---|
| `agentic-orchestration-be` | Control plane. Owns all state, authenticates users, drives the pipeline. | yes — full Postgres |
| `agentic-orchestration-ag` | Execution plane. Eve agents, tools, sandbox. | **no** |
| `agentic-orchestration-fe` | Staff console (PM / DEV / ADMIN). | anon key only |
| `alphaexplora-client-fe` / `-be` | Client-facing product. | `-be` full Postgres, `-fe` anon key |

All four Supabase consumers share one project (`gupmckxxaaxlameekihy`) and partition by Postgres
schema. `agentic-orchestration-ag` has no database access at all, by design — see
[architecture/agent-platform.md](architecture/agent-platform.md#why-the-execution-plane-has-no-database).

## Start here

**[operations/what-you-need-to-do.md](operations/what-you-need-to-do.md)** — the short list of
things that need a human: production deploys, credentials, and decisions. Everything else in the
roadmap lands without you.

## Contents

- **[architecture/agent-platform.md](architecture/agent-platform.md)** — how agents are stored,
  configured and dispatched. The capability / configuration / execution split, why capabilities
  cannot be authored from the console, and how the roster stays in sync with what is deployed.
- **[architecture/client-lifecycle.md](architecture/client-lifecycle.md)** — why a new client has
  a discovery space and not a project, why the row has to exist before any document can arrive,
  and where the console shows each.
- **[architecture/orchestration-scope.md](architecture/orchestration-scope.md)** — orchestration
  runs inside a project and nowhere else. What that constrains today, and what must change before
  it can run anywhere else.
- **[roadmap/agent-platform.md](roadmap/agent-platform.md)** — the sequenced work to finish the
  agent platform, with what is done and what is not.
- **[operations/](operations/)** — runbooks and the human-action list.

## Conventions

Each document opens with a `Status:` line. `active` means it describes the system as it is.
`target` means it describes where the system is going and the code does not fully match yet;
those documents say explicitly which parts are not built.
