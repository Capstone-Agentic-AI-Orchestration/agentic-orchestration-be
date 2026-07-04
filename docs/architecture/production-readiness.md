# DevFlow Production Readiness Contract

This document captures the current backend/frontend contract for the migrated DevFlow app. It is the working reference for keeping PM, DEV, CLIENT, and ADMIN workstreams isolated while still sharing the same project lifecycle.

## Runtime Shape

- `devlow-frontend` is the Next.js app. Route groups map to role workspaces: `(pm)`, `(dev)`, `(client)`, and `(admin)`.
- `devflow-be` is the NestJS API. Controllers expose role-scoped endpoints and services enforce project membership/data rules.
- Supabase Auth owns login sessions. The backend reads Bearer tokens, resolves the profile, and attaches the DevFlow role.
- Prisma/PostgreSQL owns business state: projects, members, tasks, work orders, artifacts, documents, conversations, timeline events, notifications, kickoff, and delivery review.

## Role Boundaries

| Area | PM | DEV | CLIENT | ADMIN |
| --- | --- | --- | --- | --- |
| Project list/detail | All assigned projects | Assigned projects | Invited projects | All |
| Project create/update/member management | Yes | No | No | Yes |
| Kickoff and work-order generation | Yes | No | No | Yes |
| Tasks and work orders | Manage all project work | View assigned work | No | Manage all |
| Work-order dispatch | Yes | No | No | Yes |
| Internal event logs | Yes | Yes | No | Yes |
| Artifact list | All project artifacts | All project artifacts | Client-visible only | All |
| Raw artifact detail/content | Yes | Yes | No | Yes |
| PM output review/publish | Yes | No | No | Yes |
| Client artifact approval/revision | No | No | Yes | No |
| Delivery acceptance/revision request | No | No | Yes | No |
| Delivery revision resolution | Yes | No | No | Yes |
| Public inquiry submit/status | Public | Public | Public | Public |
| Inquiry review/approval | Yes | No | No | Yes |

Frontend route guards mirror this matrix with `RequireAuth`; backend guards remain the source of truth.

## Lifecycle Contract

1. Public intake creates an inquiry.
2. PM/ADMIN approves intake and creates the project/client invite.
3. Client invite acceptance adds the client as a project member and records a client-visible timeline event.
4. PM/ADMIN prepares kickoff and work orders.
5. DEV sees assigned tasks/work orders and collaborates internally.
6. PM/ADMIN dispatches work orders through the orchestration bridge.
7. The bridge records execution metadata, event logs, generated artifacts, and moves linked tasks into review.
8. PM/ADMIN either approves generated output, requests rework, or publishes it to the client.
9. CLIENT can approve published artifacts/documents or request revisions.
10. CLIENT cannot accept final delivery while shared artifact/document reviews are still open.
11. PM/ADMIN resolves delivery revisions, then CLIENT can accept delivery.

## Output Handoff Rules

- Publishing an artifact makes it client-visible, resets the client artifact review to `PENDING`, and marks output review as `PUBLISHED`.
- PM rework requests require a valid developer assignee before the artifact status changes.
- Artifacts already marked `REWORK_REQUESTED` cannot be published until a new/revised output is produced.
- Client-visible artifact lists must not expose raw artifact content to CLIENT users.

## Collaboration And Review Rules

- Client-created documents are always client-visible approval requests.
- PM-created documents become approval requests when shared with the client, even if the UI/API attempted to mark them approved.
- Client-visible documents block final delivery unless their status is `APPROVED` or `ARCHIVED`.
- Archived collaboration documents cannot be reviewed.
- CLIENT users can only create client-visible conversations; DEV users can only create team conversations.
- Client invite acceptance records `CLIENT_INVITE_ACCEPTED` notification and timeline events for auditability.

## Data Integrity Rules

- Project member management is limited to PM/ADMIN users.
- A project member role must match the stored profile role. For example, a CLIENT profile cannot be added as a DEV project member.
- The final PM/ADMIN manager for a project cannot be removed.
- Inquiry approval only auto-attaches an existing profile when that profile is a CLIENT for the same email.
- Final delivery acceptance requires the accepting CLIENT user to have an accepted invite for that project.
- Manual work orders must have instructions before they can be created as `READY`, dispatched, or completed.
- Only `READY` work orders can be dispatched through the execution bridge.
- `DISPATCHED` and `COMPLETED` work orders cannot be re-scoped by changing title, instructions, agent type, priority, task, or artifact links.

## Pending And Demo Boundaries

- The orchestrator now starts with `AGENT_PROVIDER=mock`: a deterministic local LangGraph flow that dispatches READY work orders, creates artifacts, records event logs/timeline entries, and moves output to PM review without external AI keys.
- `AGENT_PROVIDER=llm` is reserved for the older model-backed graph path and requires OpenAI/Anthropic/GitHub credentials before it should be used.
- PM, DEV, and CLIENT operational workspaces should use live backend APIs only. Legacy mock datasets must not be imported by these production flows.
- The ADMIN workspace still uses isolated demo data in `devlow-frontend/src/features/admin/shared/model/admin.mock.ts` and should be treated as a demo/admin-planning surface until admin APIs are implemented.
- PM calendar, PM AI usage, PM reports, DEV folders, DEV GitHub sync, DEV calendar, IDE telemetry, scheduling, and production deployment status intentionally show backend-pending states where no durable backend model exists yet.
- Client-facing delivery acceptance is live, but production deployment automation is not connected yet.

## Verification Baseline

Use these commands as the current confidence gate:

```powershell
cd devflow-be
npm test
npm run build
npm run seed:demo
npm run seed:demo:check
npm run seed:demo:smoke

cd ..\devlow-frontend
npm run typecheck
npm run build
```

The smoke script signs in all personas and validates positive workflows plus forbidden cross-role routes.
