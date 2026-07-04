# DevFlow Microservices Readiness

## Goal

DevFlow is moving toward service isolation without forcing an unsafe physical split before deployment infrastructure, API keys, and message broker operations are ready. The current target is a modular monolith with microservice contracts: each business capability owns its data, publishes integration events through a durable outbox, and can later be extracted behind an API or queue boundary.

The orchestrator remains intentionally out of scope for runtime hardening until provider API keys are available.

## Current Boundary Map

The source-of-truth boundary map is encoded in `src/shared/architecture/service-boundaries.ts`.

| Boundary | Current module area | Owns | Extraction readiness |
| --- | --- | --- | --- |
| Identity | `auth`, `profiles`, `developers` | Supabase JWT verification, profiles, memberships, developer profiles | Contract-ready |
| Intake | `inquiries`, `client-invites` | Client inquiries, client invites, inquiry-to-project handoff | Contract-ready |
| Project delivery | `projects`, `reports`, `schedule` | Projects, tasks, work orders, artifacts, timelines, delivery review | Internal module |
| Collaboration | `collaboration` | Conversations, messages, reads, documents | Internal module |
| Notifications | `notifications` | Notification fanout and read state | Contract-ready |
| Orchestration | `orchestration`, `supervisor`, `memory`, `gateway` | Runs, executions, run budgets, event logs, agent memory, realtime updates | Internal module |
| Admin | `admin`, `github` | Admin control plane, settings, audit log, GitHub app config | Contract-ready |

## Supabase Schema Ownership

DevFlow uses one Supabase Postgres database with service-owned PostgreSQL schemas. The frontend uses Supabase directly only for Auth; application data access goes through the Nest backend. Service schemas are therefore backend-only by default and should not be exposed to `anon` or `authenticated` Data API roles unless a future public API contract explicitly requires it.

| Database schema | Owner | Tables |
| --- | --- | --- |
| `identity` | Identity | `profiles`, `developer_profiles` |
| `intake` | Intake | `client_inquiries`, `client_invites` |
| `projects` | Project delivery | `Project`, `GateEvent`, `Artifact`, `project_members`, `project_tasks`, `project_task_activities`, `project_timeline_events`, `project_kickoffs`, `project_delivery_reviews` |
| `collaboration` | Collaboration | `project_conversations`, `project_messages`, `conversation_reads`, `collaboration_documents` |
| `notifications` | Notifications | `notifications` |
| `orchestration` | Orchestration | `work_orders`, `orchestration_runs`, `work_order_executions`, `event_logs`, `run_budgets`, LangGraph checkpoint tables |
| `memory` | Orchestration memory | `agent_profiles`, `agent_memories` |
| `admin` | Admin | `admin_domains`, `admin_audit_logs`, `platform_settings` |
| `scheduling` | Project delivery scheduling | `schedule_events` |
| `integration` | Shared integration kernel | `integration_outbox`, `idempotency_records` |
| `public` | Infrastructure only | `_prisma_migrations`, `pgvector` extension objects |

Rules:

1. New application tables must not be created in `public`.
2. Every new Prisma model must include `@@schema(...)` and an owner in `prismaModelOwners`.
3. Cross-schema reads/writes are allowed only through documented modular-monolith exceptions in `allowedCrossBoundaryPrismaModels`.
4. Runtime-owned infrastructure tables may live outside Prisma only when the owning adapter is configured to use the correct service schema.
5. Do not grant `anon` or `authenticated` direct access to service schemas without adding RLS policies and documenting the public contract.

## Implemented Changes

1. Added `integration_outbox` with `IntegrationOutboxStatus` for durable cross-boundary event recording.
2. Added shared integration event contracts in `src/shared/events`.
3. Added `OutboxService` as a shared kernel primitive.
4. Published intake events for inquiry submitted, inquiry approved, inquiry rejected, and client invite accepted.
5. Published a notification-requested event when notification fanout occurs.
6. Replaced ad hoc health middleware with `/health`, `/health/live`, and `/health/ready`.
7. Updated HTTP exception responses toward RFC 7807 problem details while preserving `statusCode` as a compatibility extension.
8. Added relay-safe outbox locking, retry metadata, and a disabled-by-default in-process relay with an injectable publisher.
9. Added `idempotency_records` and `IdempotencyService` for replay-safe state-changing requests.
10. Added optional optimistic locking (`version`) for `Project`, `collaboration_documents`, `project_delivery_reviews`, `project_tasks`, and `work_orders`.
11. Added opt-in cursor pagination for collaboration and project delivery list APIs while preserving existing array responses by default.
12. Added an executable boundary import guard in `test/service-boundaries.spec.ts` backed by the source directory map in `src/shared/architecture/service-boundaries.ts`.
13. Added local Supabase-auth compatibility migrations for Docker Postgres (`auth.users`, `auth.uid()`, and Supabase API roles) so the same checked-in migrations can replay outside hosted Supabase.
14. Kept `profiles` application-owned and schema-local. `profiles.id` stores the upstream Supabase Auth user UUID, but it intentionally does not use a database FK into `auth.users`, which keeps the identity boundary extractable and avoids coupling Prisma's public schema to Supabase-managed internals.
15. Partitioned hosted Supabase tables and enums into service-owned schemas while keeping a single database.
16. Moved LangGraph checkpoint persistence into the `orchestration` schema and configured `PostgresSaver` with `{ schema: 'orchestration' }`.

## Database Migration Workflow

The migration set contains hand-written PostgreSQL DDL, including pgvector indexes and schema moves that Prisma cannot safely infer. LangGraph checkpoint tables are runtime-owned but must remain in the `orchestration` schema. Use `npm run prisma:migrate` (`prisma migrate deploy`) to apply checked-in migrations locally or in deployed environments. Use `npm run prisma:migrate:dev` only when intentionally creating Prisma-authored migrations and reviewing the generated SQL before committing it; do not accept generated drops for pgvector indexes, service schemas, or runtime checkpoint tables.

## Event Contracts

The first event names are versioned and stable:

| Event | Producer | Aggregate |
| --- | --- | --- |
| `intake.inquiry.submitted.v1` | Intake | `client_inquiry` |
| `intake.inquiry.approved.v1` | Intake | `client_inquiry` |
| `intake.inquiry.rejected.v1` | Intake | `client_inquiry` |
| `intake.client_invite.accepted.v1` | Intake | `client_invite` |
| `notifications.notification.requested.v1` | Notifications | `notification` |

Consumers should treat payloads as append-only contracts. Add fields freely, but do not remove or rename fields without introducing a new event version.

`OutboxService.append` validates event contracts before writing to `integration_outbox`: the event name must be versioned, declared by a known producer boundary, the event object's `producer` must match the event-name prefix, and `aggregateType` must match the declared event contract. Shared event contract aggregate types must use stable lower-snake-case identifiers such as `client_inquiry`.

## Outbox Relay

`OutboxRelayService` is registered in the shared kernel but is disabled unless `OUTBOX_RELAY_ENABLED=true`. When disabled, events remain in `integration_outbox` with `PENDING` status and can be inspected or relayed by an external worker.

The current default publisher logs events and marks them `PUBLISHED` only when the relay is explicitly enabled. This is useful for local development and contract testing, but production multi-service deployment should replace the `OUTBOX_PUBLISHER` provider with a broker-backed publisher that acknowledges RabbitMQ, Kafka, SQS, Supabase Realtime, or another durable transport before `markPublished`.

Relay safety rules:

1. Workers claim rows by setting `lockId`, `lockedAt`, and `lockedUntil`.
2. Failed publishes increment `attempts`, store `error`, and schedule `nextAttemptAt` with bounded exponential backoff.
3. After `OUTBOX_RELAY_MAX_ATTEMPTS`, failed events stay `FAILED` without another retry time and require operator action.
4. Multiple relays may run concurrently once a real broker publisher is installed because claims are lock-scoped.

## Idempotency

Critical state-changing endpoints can accept an `Idempotency-Key` header. The shared `IdempotencyService` scopes a key to the actor and route, hashes the request payload, records a `PROCESSING` row before running the handler, and stores the successful response for 24 hours.

Controllers should route optional idempotency handling through `executeIdempotentCommand` from the shared kernel. This keeps boundary controllers responsible for route scope and payload selection while centralizing the bypass, payload hashing, replay execution, and response-body extraction contract.

Initial coverage:

| Endpoint | Scope |
| --- | --- |
| `POST /inquiries` | `public:POST:/inquiries` |
| `POST /inquiries/:id/approve` | `user:{actorId}:POST:/inquiries/{id}/approve` |
| `POST /inquiries/:id/reject` | `user:{actorId}:POST:/inquiries/{id}/reject` |
| `POST /client-invites/accept` | `user:{actorId}:POST:/client-invites/accept` |
| `PATCH /notifications/read-all` | `user:{actorId}:PATCH:/notifications/read-all` |
| `PATCH /notifications/:id/read` | `user:{actorId}:PATCH:/notifications/{id}/read` |
| `PATCH /profiles/me` | `user:{actorId}:PATCH:/profiles/me` |
| `PATCH /developers/me/capacity` | `user:{actorId}:PATCH:/developers/me/capacity` |
| `POST /projects` | `user:{actorId}:POST:/projects` |
| `PATCH /projects/:id` | `user:{actorId}:PATCH:/projects/{id}` |
| `POST /projects/:id/members` | `user:{actorId}:POST:/projects/{id}/members` |
| `DELETE /projects/:id/members/:userId` | `user:{actorId}:DELETE:/projects/{id}/members/{userId}` |
| `PATCH /projects/:id/artifacts/:artifactId/share` | `user:{actorId}:PATCH:/projects/{id}/artifacts/{artifactId}/share` |
| `POST /projects/:id/artifacts/:artifactId/review` | `user:{actorId}:POST:/projects/{id}/artifacts/{artifactId}/review` |
| `PATCH /projects/:id/artifacts/:artifactId/revision` | `user:{actorId}:PATCH:/projects/{id}/artifacts/{artifactId}/revision` |
| `PATCH /projects/:id/artifacts/:artifactId/output-review` | `user:{actorId}:PATCH:/projects/{id}/artifacts/{artifactId}/output-review` |
| `POST /projects/:id/artifacts/:artifactId/publish` | `user:{actorId}:POST:/projects/{id}/artifacts/{artifactId}/publish` |
| `POST /projects/:id/tasks` | `user:{actorId}:POST:/projects/{id}/tasks` |
| `PATCH /projects/:id/tasks/:taskId` | `user:{actorId}:PATCH:/projects/{id}/tasks/{taskId}` |
| `POST /projects/:id/tasks/:taskId/comments` | `user:{actorId}:POST:/projects/{id}/tasks/{taskId}/comments` |
| `POST /projects/:id/work-orders` | `user:{actorId}:POST:/projects/{id}/work-orders` |
| `PATCH /projects/:id/work-orders/:workOrderId` | `user:{actorId}:PATCH:/projects/{id}/work-orders/{workOrderId}` |
| `POST /projects/:id/work-orders/:workOrderId/dispatch` | `user:{actorId}:POST:/projects/{id}/work-orders/{workOrderId}/dispatch` |
| `POST /projects/:id/work-orders/:workOrderId/retry` | `user:{actorId}:POST:/projects/{id}/work-orders/{workOrderId}/retry` |
| `POST /projects/:id/delivery-review/accept` | `user:{actorId}:POST:/projects/{id}/delivery-review/accept` |
| `POST /projects/:id/delivery-review/revision` | `user:{actorId}:POST:/projects/{id}/delivery-review/revision` |
| `PATCH /projects/:id/delivery-review/resolve` | `user:{actorId}:PATCH:/projects/{id}/delivery-review/resolve` |
| `PATCH /projects/:id/kickoff` | `user:{actorId}:PATCH:/projects/{id}/kickoff` |
| `POST /projects/:id/kickoff/tasks` | `user:{actorId}:POST:/projects/{id}/kickoff/tasks` |
| `POST /projects/:id/kickoff/work-orders` | `user:{actorId}:POST:/projects/{id}/kickoff/work-orders` |
| `POST /projects/:id/gates/architecture` | `user:{actorId}:POST:/projects/{id}/gates/architecture` |
| `POST /projects/:id/gates/code` | `user:{actorId}:POST:/projects/{id}/gates/code` |
| `POST /schedule/events` | `user:{actorId}:POST:/schedule/events` |
| `PATCH /schedule/events/:id` | `user:{actorId}:PATCH:/schedule/events/{id}` |
| `DELETE /schedule/events/:id` | `user:{actorId}:DELETE:/schedule/events/{id}` |
| `POST /projects/:projectId/conversations` | `user:{actorId}:POST:/projects/{projectId}/conversations` |
| `POST /projects/:projectId/conversations/:conversationId/messages` | `user:{actorId}:POST:/projects/{projectId}/conversations/{conversationId}/messages` |
| `PATCH /projects/:projectId/conversations/:conversationId/read` | `user:{actorId}:PATCH:/projects/{projectId}/conversations/{conversationId}/read` |
| `POST /projects/:projectId/documents` | `user:{actorId}:POST:/projects/{projectId}/documents` |
| `PATCH /projects/:projectId/documents/:documentId` | `user:{actorId}:PATCH:/projects/{projectId}/documents/{documentId}` |
| `POST /projects/:projectId/documents/:documentId/review` | `user:{actorId}:POST:/projects/{projectId}/documents/{documentId}/review` |
| `PATCH /admin/users/:id/role` | `user:{actorId}:PATCH:/admin/users/{id}/role` |
| `PATCH /admin/users/:id/status` | `user:{actorId}:PATCH:/admin/users/{id}/status` |
| `POST /admin/domains` | `user:{actorId}:POST:/admin/domains` |
| `PATCH /admin/domains/:id` | `user:{actorId}:PATCH:/admin/domains/{id}` |
| `POST /admin/domains/:id/verify` | `user:{actorId}:POST:/admin/domains/{id}/verify` |
| `DELETE /admin/domains/:id` | `user:{actorId}:DELETE:/admin/domains/{id}` |
| `POST /admin/projects/:id/repository/create` | `user:{actorId}:POST:/admin/projects/{id}/repository/create` |
| `PATCH /admin/projects/:id/repository` | `user:{actorId}:PATCH:/admin/projects/{id}/repository` |
| `POST /admin/projects/:id/handoff/override` | `user:{actorId}:POST:/admin/projects/{id}/handoff/override` |
| `PATCH /admin/settings/:key` | `user:{actorId}:PATCH:/admin/settings/{key}` |

Idempotency safety rules:

1. Reusing a key with a different request hash returns `400`.
2. Replaying while the original request is still processing returns `409`.
3. Replaying after successful completion returns the stored response body without rerunning business logic.
4. Concurrent first requests rely on the database unique constraint over `(key, scope)`; the loser rereads the winning row and follows the same replay rules.

## Optimistic Locking

`Project`, `collaboration_documents`, `project_delivery_reviews`, `project_tasks`, and `work_orders` now include integer `version` columns. Update DTOs accept an optional `version` field:

1. If a client sends `version`, the service updates with `WHERE id = ? AND version = ?`.
2. If no row is updated, the API returns `409` and does not write timeline/activity side effects.
3. Successful updates increment `version`.
4. Existing clients that do not send `version` continue to work, and their successful updates still increment the stored version.

This is the compatibility phase. Once the frontend consistently sends versions, these endpoints can move from optional to required version checks. Project-level edits, collaboration document updates/reviews, delivery review transitions, task updates, and work-order updates now share the same contract, which makes project delivery and collaboration commands safer to extract behind service boundaries.

## Cursor Pagination

Admin, identity, intake, collaboration, project delivery, and notification list endpoints now support opt-in cursor pagination with `limit` and `cursor` query parameters:

| Endpoint | Default response | Paged response |
| --- | --- | --- |
| `GET /projects/:projectId/conversations` | Existing array response | `{ items, nextCursor }` |
| `GET /projects/:projectId/conversations/:conversationId/messages` | Existing array response | `{ items, nextCursor }` |
| `GET /projects/:projectId/documents` | Existing array response | `{ items, nextCursor }` |
| `GET /projects` | Existing array response | `{ items, nextCursor }` |
| `GET /projects/:id/artifacts` | Existing array response | `{ items, nextCursor }` |
| `GET /projects/:id/tasks/:taskId/activity` | Existing array response | `{ items, nextCursor }` |
| `GET /projects/:id/tasks` | Existing array response | `{ items, nextCursor }` |
| `GET /projects/:id/work-orders` | Existing array response | `{ items, nextCursor }` |
| `GET /schedule/events` | Existing array response | `{ items, nextCursor }` |
| `GET /projects/:id/timeline` | Existing array response | `{ items, nextCursor }` |
| `GET /projects/:id/events` | Existing array response | `{ items, nextCursor }` |
| `GET /notifications` | Existing array response | `{ items, nextCursor }` |
| `GET /inquiries` | Existing array response | `{ items, nextCursor }` |
| `GET /client-invites/me` | Existing array response | `{ items, nextCursor }` |
| `GET /admin/users` | Existing array response | `{ items, nextCursor }` |
| `GET /admin/domains` | Existing array response | `{ items, nextCursor }` |
| `GET /admin/repositories` | Existing array response | `{ items, nextCursor }` |
| `GET /admin/handoffs` | Existing array response | `{ items, nextCursor }` |
| `GET /developers` | Existing array response | `{ items, nextCursor }` |

When pagination is requested, the service uses cursor-based Prisma reads with `take = limit + 1`, `cursor`, and `skip: 1`, then returns `nextCursor` from the extra row. This keeps existing clients compatible while giving extractable admin, identity, intake, collaboration, project delivery, and notification APIs a stable non-offset pagination contract.

## Extraction Order

1. **Notifications service**: lowest domain complexity, clear fanout behavior, and already has event contracts.
2. **Intake service**: clear ownership of public inquiry and invite lifecycle, but depends on project creation handoff.
3. **Admin service**: mostly independent control plane and audit operations.
4. **Collaboration service**: extract after project membership and authorization contracts are stable.
5. **Project delivery service**: extract after task/work-order contracts and timeline ownership are settled.
6. **Orchestration service**: defer until provider keys, real model behavior, and recovery semantics are testable.

## Database Guidance

The app currently uses one Prisma client over service-owned PostgreSQL schemas. During the modular-monolith phase, enforce ownership in code, schema placement, grants, and documentation. Before extracting a service, create service-owned database access paths:

1. Move read/write methods for owned tables behind that boundary's service API.
2. Replace direct cross-boundary Prisma reads with API calls or event-built read models.
3. Keep the outbox write in the same transaction as the aggregate change.
4. Add an outbox relay worker that marks `PUBLISHED` only after the broker acknowledges delivery.
5. Use expand/contract migrations for breaking table changes.

## Boundary Import Guard

`test/service-boundaries.spec.ts` scans `src/**/*.ts` import/export declarations, side-effect imports, literal dynamic imports, and literal `require(...)` calls. Direct relative imports may only target the same boundary, shared/platform code, or boundaries listed in `dependsOn`.

Platform modules are intentionally exempt because they are shared runtime adapters rather than business capabilities: `common`, `config`, `github`, `health`, `prisma`, and `shared`. Every top-level `src` directory must be classified as either a service-boundary directory or platform directory, and each source directory must have exactly one owner; root entrypoint files such as `src/main.ts` are ignored. Every source-owned boundary must also have exactly one boundary definition, every boundary definition must point at a source-owned boundary, and `dependsOn` cannot contain unknown, duplicate, or self dependencies. New business modules should be added to `serviceBoundarySourceDirectories`; new cross-boundary imports should update `dependsOn` only when the dependency is intentional and compatible with later extraction. The same dependency graph must also include the owner of every documented cross-boundary Prisma exception, so `dependsOn` reflects both code imports and current shared-database coupling.

The same test file also scans controller mutation routes. Non-orchestrator `@Post`, `@Patch`, and `@Delete` handlers must accept `Idempotency-Key` and delegate through `executeIdempotentCommand` or a local `runIdempotent` wrapper. Orchestration routes remain excluded until provider keys and runtime smoke tests are available.

Pagination drift is guarded in the same suite. Production code must not introduce raw Prisma `skip:` offset pagination outside `src/shared/pagination/cursor-pagination.ts`; list endpoints should accept `CursorPageInput`, read with `cursorQueryArgs`, and shape responses with `toCursorPage`.

Database ownership is now executable as well. The Prisma model owner map and current cross-boundary exception register live in `src/shared/architecture/service-boundaries.ts`; `test/service-boundaries.spec.ts` fails on direct Prisma model access from a boundary that neither owns the model nor has a documented exception. The same test parses `prisma/schema.prisma` and fails if a new model is missing from the owner map. Existing exceptions represent current modular-monolith coupling for admin dashboards, intake handoff, notification fanout context, collaboration authorization, project delivery summaries, and orchestration/project delivery coordination. Each exception must include the reason it exists and the API, event, or read model that should replace it. The register is also checked for stale entries: exceptions must point to known non-platform models owned by another boundary, not models already owned by the same module, and each exception owner must appear in the source boundary's `dependsOn` list. New models need an owner immediately; new exceptions should be treated as extraction debt.

Integration event contracts are guarded too. Event names must use `<producer>.<aggregate>.<action>.vN`, the producer prefix must be a known service boundary, and the producing boundary must list the event in its `publishes` declaration. The same guard now checks that every published event has shared contract metadata, contract producers match event-name prefixes, aggregate types use lower snake case, and duplicate event contract definitions are rejected. Runtime outbox writes additionally check the event object's `aggregateType` against the shared contract registry.

## Reliability Recommendations

1. Replace the local log publisher with a durable broker publisher before deploying multiple services.
2. Audit idempotency coverage whenever new non-orchestrator mutation routes are added.
3. Audit new list endpoints for cursor pagination and keep offset-style reads out of service-boundary contracts.
4. Keep orchestrator provider mode on `mock` until API keys and provider-specific smoke tests are available.
