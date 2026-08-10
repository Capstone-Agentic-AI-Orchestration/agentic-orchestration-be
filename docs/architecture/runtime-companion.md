# Runtime Companion — Implementation Plan

> **Status: PROPOSAL. Not built.** Unlike most documents in this directory, this one describes work
> that has not happened. The server and browser halves of the feature exist and are complete; the
> client daemon that connects them does not exist anywhere — not on disk, and not as a repository in
> the `Capstone-Agentic-AI-Orchestration` org.
>
> Deferred deliberately. Written so it can be picked up cold without the conversation that produced it.

---

## Purpose of the feature

Run agent work orders on a developer's own machine, through an AI CLI they already have installed and
signed in — Claude Code or Codex — instead of through a metered API call.

The economic point, stated in `companion-agent.provider.ts`: an agent's output comes from a CLI
*"signed in under the person's own subscription, rather than from a metered API call."* This converts
per-token API spend into the flat-rate subscription a developer already pays for.

The work order remains the unit of record. Only execution moves off-box, and the artifact is saved
through the same contract and validator as the cloud path — a companion-produced artifact is
indistinguishable downstream.

`CompanionAgentProvider` is deliberately a **peer** of the LLM provider, not a variant of it. They
share no transport, because there is no HTTP request to a model at all: a row is queued, a laptop
picks it up, and the answer arrives later.

---

## Why a client process is required

Detection cannot happen server-side, for two independent reasons:

1. A browser cannot read a filesystem.
2. The API runs on a server with no view of the user's computer.

An earlier version got this wrong. Per `runtimes.module.ts`, local CLI detection *"used to live here
too, probing the API host's own disk — which described the server, never the user."* The daemon is the
correction, and this constraint is not negotiable by any amount of server-side cleverness.

---

## Current state

| Half | Status | Location |
|------|--------|----------|
| Server (REST + WS + persistence) | **Complete** | `src/runtime-companion/`, `src/runtimes/` |
| Browser (console UI + loopback pairing) | **Complete** | `agentic-orchestration-fe` `src/features/admin/runtimes/` |
| Client daemon | **Does not exist** | — |

Six Prisma models exist and are migrated (`RuntimeMachine`, `RuntimeAdapter`, `RuntimeResource`,
`RuntimeTask`, `RuntimePairingCode`, `AiRuntimeProvider`), all in the `orchestration` physical schema.
All are registered in `src/shared/architecture/service-boundaries.ts` under the `orchestration`
boundary.

### The "already-shipped client" misconception

Three separate comments in the backend describe the daemon's wire contract as fixed by an existing
client:

- `runtime-companion.controller.ts` — *"fixed by the already-shipped client — this side has to match
  it exactly, not the other way round"*
- `runtime-task.service.ts` — *"The shape the shipped companion expects from a claim. Fixed by that
  client, not by us."*
- `dto/runtime-companion.dto.ts` — *"the shipped daemon's shape is fixed and cannot be adjusted to
  suit the server"*

**No such client was ever shipped.** These describe an intended specification, not a deployed reality.
Consequence: the contract below is a *starting point you are free to simplify*, not a frozen external
dependency. Whoever implements this should also correct those three comments, because they will
otherwise mislead every future reader into treating the shape as immovable.

---

## Blocker 1 — companion mode cannot be switched on

`src/config/env.schema.ts`:

```ts
AGENT_PROVIDER: z.enum(['mock', 'llm', 'simulation']).optional().default('mock'),
```

`'companion'` is absent from the enum. Validation is `safeParse` followed by `throw`, so setting
`AGENT_PROVIDER=companion` does **not** fall back to `mock` — it crashes the backend at boot with a
configuration error. `agent-provider.registry.ts:109` (`if (process.env.AGENT_PROVIDER === 'companion')`)
is therefore unreachable dead code.

The comment directly above the enum documents the same mistake being made and fixed once already, for
`'simulation'`: *"The provider registry has always supported it; this enum was the only thing blocking
it."*

**Fix:** add `'companion'` to the enum. One line. This is a latent boot-crash bug and is worth fixing
independently of any daemon work.

---

## Blocker 2 — the daemon

This is the actual work. Everything below specifies it.

---

## Wire contract

### Loopback surface (browser → daemon)

The console probes `http://127.0.0.1:19519` on every page load. Browsers treat `127.0.0.1` as a
trustworthy origin, so an HTTPS page is permitted to reach a plain-HTTP local service.

Every failure path in the browser client resolves to `null` rather than throwing — a missing companion
is the normal case, not an error, and the page must work identically without it.

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/info` | → `{product, runtimeVersion, machineName, os, arch, paired, machineId?}` |
| `POST` | `/pair` | Body `{code}`. **Requires header `x-devflow-pair: 1`** |

- `product` **must** be the literal `"devflow-runtime"`. The console checks it to guard against an
  unrelated service occupying the port.
- Port is overridable in the console via `NEXT_PUBLIC_RUNTIME_PORT`; default `19519`.
- The `x-devflow-pair` header is a CSRF defence, not metadata: it forces a CORS preflight, which a
  plain cross-site HTML form cannot produce. Do not make it optional.
- The daemon must set CORS from the origins it learns via `GET /discovery` (below), not from a
  hardcoded list.
- Only the pairing code travels over loopback. The daemon uses the server URL it was configured with,
  which is what stops a hostile page from redirecting someone's machine at a server of its choosing.

Browser-side timeouts already in place: 1.5s probe, 15s pair.

### Server surface (daemon → API)

Base path `/api/v2/runtime-companion`. No global prefix is set in `main.ts`, so the path is spelled
out in full.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/discovery` | none | → `{webOrigins}` for the daemon's CORS config |
| `GET` | `/install.cmd` | none | Setup script download |
| `POST` | `/registrations/complete` | pairing code | Exchange code → machine token |
| `POST` | `/heartbeat` | machine token | Liveness + adapter reconciliation, every 30s |
| `POST` | `/resources` | machine token | Register a working directory |
| `POST` | `/token/rotate` | machine token | Bodyless |
| `POST` | `/adapters/:adapterId/claim` | machine token | Ask for work, every 5s |
| `POST` | `/tasks/:taskId/heartbeat` | machine token | Keep lease alive, every 15s |
| `POST` | `/tasks/:taskId/complete` | machine token | Report outcome |

Authentication is the header **`x-runtime-token`**. The daemon sends no `Authorization` header and no
cookies. The token is opaque, `randomBytes(32).toString('base64url')`, and belongs in the OS
credential manager.

`/discovery` and `/install.cmd` are unauthenticated by design — they contain no secrets, only the
API's own public address, and pairing still requires a signed-in session.

**Idempotency:** these routes are exempt from the repo's mutation-idempotency rule
(`defaultIgnoredMutationSourcePathFragments`). The daemon does not need to send an `Idempotency-Key`.
`claim` in particular must **never** be made key-idempotent — replay would hand back a lease the
companion already finished. Task safety comes from the lease token and the reaper instead. The
browser-facing half (`machines.controller.ts`, `runtimes.controller.ts`) is not exempt and does use
keys.

### Payloads

`POST /registrations/complete`

```
{ code, name, os, arch, runtimeVersion }
```
`os` is `process.platform`, `arch` is `process.arch`. `code` is sent exactly as the user typed it —
lowercase, missing dash, stray spaces and all. The server normalizes before lookup.

`POST /heartbeat`

```
{ runtimeVersion, adapters: [{ kind, displayCommand, version, authenticated, capabilities }] }
```
`version` is `null` when the CLI is missing or would not run.

**The daemon strips two things before sending: its own computed `status`, and the resolved executable
path.** The server never receives a filesystem path and derives status itself. Preserve this — it means
a compromised daemon cannot mark a missing CLI as available.

Response returns adapter ids; the daemon's claim loop iterates the ids it was handed.

`POST /resources`

```
{ opaqueId, name, fingerprint, capabilities: { access: 'READ_ONLY'|'READ_WRITE', filesystem? } }
```
`access` is nested inside `capabilities`, **not** top-level. `opaqueId` is client-generated
(`res_<base64url>`) and treated as untrusted. Upserted on `(machine, opaqueId)`.

`POST /tasks/:taskId/heartbeat` → `{ leaseToken }`. Reply carries the cancellation flag; this is the
companion's only inbound channel while a task is running, so it must be honoured.

`POST /tasks/:taskId/complete` → `{ leaseToken, succeeded, result?, error? }`. `result` can reach 5MB,
which is why `main.ts` raises the JSON body limit to 8MB.

### Wake channel (optional)

`RuntimeGateway` on the `/runtime` Socket.IO namespace, separate from `/devflow` because that one
authenticates a Supabase user JWT which a headless daemon does not have. Authenticate via
`handshake.auth.token` using the same machine token. Sole event: `runtime.task.available` — payload is
ignored, it just triggers an immediate poll.

Purely an optimisation. All state travels over HTTP and the daemon falls back to the 5s poll, so a
namespace that never connects costs latency and nothing else.

---

## Dispatch eligibility

### Adapter kinds

Eight kinds are **detected**: `CLAUDE_CODE`, `CODEX_CLI`, `COPILOT_CLI`, `OPENCODE_CLI`,
`ANTIGRAVITY_CLI`, `HERMES_CLI`, `REASONIX_CLI`, `GEMINI_CLI`.

Two are **dispatchable**: `CLAUDE_CODE`, `CODEX_CLI` — the only ones with a verified headless
invocation. Detection is intentionally broader than execution. The split is enforced server-side twice
(at queue time and again on claim) because *"a stale row must not be able to send work to a CLI whose
invocation we have never verified."*

### Status derivation

Computed by the server in `deriveAdapterStatus`, never trusted from the client:

| Condition | Status |
|-----------|--------|
| `version` null | `MISSING` |
| `version` present, `authenticated` false | `UNAUTHENTICATED` |
| `version` present, `authenticated` true | `AVAILABLE` |

### What a machine needs to receive work

- `revokedAt` null
- `lastSeenAt` within 90s
- ≥1 adapter that is `enabled` **and** `authenticated` **and** `AVAILABLE` **and** a dispatchable kind
- ≥1 registered resource

Machine selection prefers one owned by whoever started the run, so *"my agents use my AI"* is literally
true rather than approximately true. Falls back to most-recently-seen.

---

## Timing constants

Every value is derived from another. Changing one in isolation will break something.

| Constant | Value | Derivation |
|----------|-------|-----------|
| Machine heartbeat | 30s | — |
| `MACHINE_ONLINE_WINDOW_MS` | 90s | 3 missed heartbeats; one slow request must not flicker a machine offline |
| Task heartbeat | 15s | — |
| `TASK_LEASE_MS` | 90s | several consecutive misses; a brief drop must not steal work from a machine still running it |
| `MAX_TASK_ATTEMPTS` | 3 | then failed outright rather than requeued |
| Claim poll | 5s | why auth must be a single indexed read |
| `TOKEN_ROTATION_GRACE_MS` | 10min | a running daemon cannot notice a rotation performed by a separate CLI invocation |
| `WAIT_TIMEOUT_MS` | 10min | **must stay under `ORCHESTRATION_JOB_LOCK_MS` (15min)** or the job is reclaimed while the work is legitimately still running |
| `MAX_PROMPT_CHARS` | 46,000 | the companion slices at 50,000; overshooting truncates silently |
| Pairing code TTL | 15min | single-use, consumed atomically |
| Body limit | 8MB | `result` output can reach 5MB |

Pairing codes are `ABCD-EFGH`. The alphabet excludes `0/O/1/I/L` because the code is read off a screen
and retyped; the dash carries no meaning and is stripped before hashing.

---

## Architecture decision — app as runner, not app as UI

Recommended: **desktop app as the runner, web console stays the UI.**

| | App as runner | App as UI |
|---|---|---|
| Loopback pairing | Kept, and becomes *more* reliable — a launch-at-login app is dependably present, where a daemon often is not | Removed entirely: app signs in normally and self-registers |
| Console surface | Reuses everything already built | Requires rebuilding machine management inside the app |
| `local-companion.ts`, `/pair`, `x-devflow-pair`, PNA/Safari loopback handling | All still needed | All become dead weight |

Rationale for runner: the web console already exists, already has the Runtimes page, and remains the
single source of truth. App-as-UI discards working frontend code for no functional gain.

The server contract is **identical either way**. Packaging changes only the shell around the client.

### Packaging options

| Option | Size | Trade-off |
|--------|------|-----------|
| Electron | ~100MB | Lowest friction for a TypeScript team; heavy for a background poller |
| Tauri | ~10MB | Adds Rust to the toolchain; earns its keep if download size becomes an objection |
| Plain Node + SEA/pkg | small | Solves the Node prerequisite but not lifecycle, tray UI, or auto-update |

Lean Electron for team fit; revisit if size draws complaints.

### What packaging genuinely buys

- **Removes the adoption blocker.** The current `install.cmd` requires Node 20+ preinstalled *and*
  expects the companion source already sitting next to the script. That is a developer setup, not a
  download.
- **Lifecycle becomes solved.** Launch-at-login + tray, instead of a Windows service or scheduled task.
- **Auto-update becomes possible, and the server is already prepared** — `runtimeVersion` is reported
  on every heartbeat and persisted on the machine row. Currently inert telemetry; with a versioned app
  it becomes "your companion is out of date," and dispatch could be gated on a minimum version.
- **Trust.** Users are being asked to run something that executes AI CLIs against their filesystem. A
  signed installer is a far easier ask than an unsigned `.cmd` that fetches from a server. An app can
  also *show* which task and directory are active, instead of the work being invisible.

### What packaging newly costs

- Code signing (Windows EV cert, annual) and Apple notarization (recurring process).
- An update channel into developer machines — a supply-chain surface that did not previously exist.
- Three platforms instead of one script.

---

## Phases

### Phase 0 — unblock the switch
Add `'companion'` to the `AGENT_PROVIDER` enum in `src/config/env.schema.ts`.

*Independent of everything else. Fixes a latent boot crash. Minutes.*

### Phase 1 — daemon skeleton, pairing only
App shell with tray icon and launch-at-login. Loopback `GET /info` and `POST /pair` on port 19519.
Fetch `/discovery` and configure CORS from it. Exchange code via `/registrations/complete`. Store the
machine token in the OS credential manager.

**Success:** the existing "Connect a machine" modal in the console finds the app and pairs. No task
execution.

### Phase 2 — presence and capability
30s heartbeat. Probe the CLI for a version and determine whether a session is signed in; report
`authenticated`. Strip `status` and executable path before sending. Register a working directory with
an access mode.

> **Unresolved, and the riskiest unknown in this plan:** how to detect "signed in" for each CLI without
> spending a paid request. The repo does not establish this anywhere — no CLI invocation for Claude Code
> or Codex appears in the backend. Both the auth probe and the headless invocation below need to be
> confirmed against the actual CLIs before Phase 2/3 estimates mean anything. Spike this first.

**Success:** machine shows online in the console; Claude Code shows `AVAILABLE`.

### Phase 3 — execution
5s claim poll per adapter id. Run the CLI headless in the resource directory, capturing stdout as JSON.
The exact flags are unverified (see the Phase 2 note) — confirm against the installed CLI rather than
assuming. 15s task heartbeat honouring `cancelRequested`. POST result to `/tasks/:taskId/complete`.

Server-side output parsing already tolerates envelope variation: `extractContent` does a depth-first
search for any string `content` field rather than assuming a fixed path, falling back to raw text
because *"saving the output beats discarding real work over a formatting mismatch."*

**Success:** a real work order produces an artifact that passes the same validator as the cloud path.

### Phase 4 — flip and verify
Set `AGENT_PROVIDER=companion`. Run a project end to end. Confirm artifact metadata records
`executedBy: 'companion'` plus `machineId`, `machineName`, `adapterKind`, `runtimeTaskId`. Add the
update channel and consider a minimum-version dispatch gate.

---

## Known gaps and small wins

- **The wake channel is unwired.** `RuntimeGateway.notifyTaskAvailable()` is never called.
  `CompanionAgentProvider` creates the task row and goes straight to polling, so every task waits up to
  5s unnecessarily. One call at queue time closes it. Independent of the daemon.
- **Installer assumes a local checkout.** `install.cmd` looks for `agentic-orchestration-runtime`
  beside the script or one directory up. Nothing satisfies that today.
- **Windows-only installer.** Batch script, no macOS/Linux equivalent.
- **`AGENT_PROVIDER` is global.** Flipping it routes *all* orchestration to laptops. The `providerMode`
  snapshot is already recorded per run, so per-project or per-run selection is a plausible extension
  rather than a rewrite.
- **Correct the three "already-shipped client" comments** listed above.

---

## Open decisions

1. **OS scope for Phase 1** — Windows-first (matching the existing installer) or cross-platform from
   the start?
2. **Where the daemon lives** — a fourth repo named `agentic-orchestration-runtime` (which is what
   `install.cmd` already expects), or a directory inside an existing repo?
3. **Global vs per-run provider selection** — is a global `AGENT_PROVIDER` switch acceptable for the
   first cut?
4. **Packaging now or later** — if this is only for the internal team, a plain Node daemon is
   sufficient and signing overhead buys nothing yet. Package once the execution path is proven. The
   daemon is the hard part either way and is identical in both worlds.

---

## Risks

**Subscription terms.** Using a personal Claude Pro/Max subscription to serve automated agent work
inside a platform may conflict with terms that generally cover individual interactive use rather than
programmatic serving. This is a licensing question, not a technical one, and it is unaffected by
packaging. Worth resolving before this becomes a default execution path for a product.

**Availability.** An API key is always reachable; a laptop has to be awake. `isAvailable()` is a live
database query against `lastSeenAt`, and the registry reports companion mode as available while letting
dispatch fail with a precise message — because whether it works depends on whether someone's computer
is on.

**Update channel.** Shipping an auto-updating app means owning a code path into developer machines.

---

## Security properties to preserve

These are already correct server-side and the daemon must not undermine them.

- Machine tokens and pairing codes are stored as SHA-256 hashes, never plaintext — a database dump does
  not confer the ability to impersonate a workstation.
- Pairing codes are single-use, consumed atomically via a conditional update on
  `{ consumedAt: null, expiresAt: { gt: now } }`, so a race cannot redeem one twice.
- Task claims use a conditional `updateMany` on `QUEUED → LEASED`, so two daemons racing cannot both
  win the same row.
- The server never receives a filesystem path, and derives adapter status itself.
- The generated prompt instructs: *"Do not read credentials, browser sessions, or anything outside the
  working directory."* This is a prompt-level constraint only — it is **not** enforced by a sandbox.
  Real containment would need to come from the daemon.
- Machine ownership, not role, is the access boundary: *"an admin has no more business seeing a
  developer's laptop than the other way round."*

---

## Reference — key files

| Concern | Path |
|---------|------|
| Provider integration | `src/orchestration/providers/companion-agent.provider.ts` |
| Provider selection | `src/orchestration/providers/agent-provider.registry.ts` |
| Env enum (Blocker 1) | `src/config/env.schema.ts` |
| Daemon REST surface | `src/runtime-companion/runtime-companion.controller.ts` |
| Console REST surface | `src/runtime-companion/machines.controller.ts` |
| Pairing, heartbeat, resources | `src/runtime-companion/runtime-companion.service.ts` |
| Task leasing | `src/runtime-companion/runtime-task.service.ts` |
| Lease reaper | `src/runtime-companion/runtime-task-reaper.service.ts` |
| Token minting and hashing | `src/runtime-companion/runtime-token.service.ts` |
| Machine auth guard | `src/runtime-companion/runtime-token.guard.ts` |
| Wake channel | `src/runtime-companion/runtime.gateway.ts` |
| Kinds, windows, constants | `src/runtime-companion/runtime-machine.types.ts` |
| Wire payload contract | `src/runtime-companion/dto/runtime-companion.dto.ts` |
| Installer generator | `src/runtime-companion/installer-script.ts` |
| Cloud provider keys + Vault | `src/runtimes/` |
| Boundary registration | `src/shared/architecture/service-boundaries.ts` |
| Console UI | `agentic-orchestration-fe` `src/features/admin/runtimes/` |
| Loopback client | `agentic-orchestration-fe` `src/features/admin/runtimes/lib/local-companion.ts` |
