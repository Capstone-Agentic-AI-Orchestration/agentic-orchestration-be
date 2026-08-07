# Client lifecycle: discovery is not delivery

Status: active.

A new client has no projects. It does have a **discovery space**, and the difference between
those two statements is the whole of this document.

## The problem this solves

Approving an inquiry created a client *and* a project, and the console counted that project like
any other. A client you had only just accepted — no scope agreed, no documents received, nothing
built — appeared on the Clients page as "1 project" and on the Projects page as delivery work in
flight. The roster of work in progress was wrong from the moment a lead was approved.

The instinct is to stop creating the row. That breaks the thing it is there for.

## Why the row has to exist

Everything the pre-delivery phase produces is attached to a project, in the schema, as a required
column:

| Model | Column | Constraint |
|---|---|---|
| `ClientInvite` | `projectId` | required, `@unique` |
| `ProjectIntake` | `projectId` | required, `@unique` |
| `CollaborationDocument` | `projectId` | required |

So "wait for the documents from the client" has nowhere to put the documents unless a project
row exists first. The discovery space **is** the document-collection phase — it is what the
client's invite points at, what the intake form writes to, and what uploads land in.

Creating it later, at the moment the first document arrives, would mean the invite has no target
and the client cannot be let in at all.

## The state that already existed

`ProjectStatus.DISCOVERY` is the first value of the enum and the control plane already treats it
as pre-delivery:

- `assertDeliveryStarted()` refuses to start orchestration on a `DISCOVERY` project, with an
  error telling the PM to agree scope and collect documents first
- `startDelivery()` is the deliberate hand-off — `DISCOVERY → PENDING` — and everything gathered
  during discovery carries over untouched, because it was always attached to this same row
- the originating `ClientInquiry` stays `IN_DISCOVERY` and only becomes `APPROVED` at that
  promotion

So the backend never confused the two. Only the console did, by counting rows without reading
their status.

## What the console shows now

| Surface | Discovery | Delivery |
|---|---|---|
| Clients list card | "In discovery" | "N projects" |
| Client → Overview stat | `+N in discovery` under the number | counted |
| Client → Projects tab | listed, badged **in discovery** | listed, status badge |
| Projects page | **hidden** | listed |

Discovery spaces are deliberately absent from the Projects page and deliberately present on the
client's own page. The Projects page answers "what is my team building"; a discovery space is not
an answer to that. The client page answers "where do things stand with this company", and there
the discovery space is the most important thing on it — it is where the PM uploads what the
client sends and where the **Start delivery** action is reached, by opening the project.

Hiding it from the Projects page without keeping that route would have made discovery
unreachable. The list on the client page is the route.

## Why presentation rather than a schema change

The alternative designs both cost more than they return:

- **A separate `DiscoverySpace` model.** Every document, invite and intake relation would need a
  second nullable parent, and `startDelivery()` would become a data migration instead of a status
  update. The promotion is currently a single `UPDATE`; that is a property worth keeping.
- **Deferring project creation.** Discussed above — the invite has nothing to point at, so the
  client cannot be onboarded at all.

`DISCOVERY` is already the marker. The fix is to read it.

## Counts are split at the source

`ClientsService.list()` returns two numbers rather than one, so the console never has to infer
the split from a status string it may not have fetched:

```ts
projectCount:   client.projects.filter((p) => p.status !== ProjectStatus.DISCOVERY).length,
discoveryCount: client.projects.filter((p) => p.status === ProjectStatus.DISCOVERY).length,
```

`projectCount` narrowed in meaning here — it now counts delivery projects only. It is consumed
by the staff console's Clients page and nothing else; the identically-named fields in
`alphaexplora-client-fe` (`DevFlowAdminUser.projectCount`) and `admin.service.ts` are unrelated
and were not touched.

## Related

- [agent-platform.md](agent-platform.md#workspace-ownership-is-a-database-invariant) — inquiry
  approval also had to start carrying a workspace, for the same reason: it creates two rows and
  owned the correctness of neither
- [orchestration-scope.md](orchestration-scope.md) — orchestration runs inside a project, which
  is why a project must exist before delivery and why discovery must refuse to run one
