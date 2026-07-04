# DevFlow Dashboard — Setup Guide

This document covers how to run, configure, and understand the DevFlow Dashboard frontend.
It is written for capstone panel review and for developers onboarding to the project.

---

## Overview

The DevFlow Dashboard is a Next.js 14 App Router application that provides a browser-based
interface for the DevFlow AI Orchestration system. Users submit a project brief, monitor the
AI agent pipeline in real time, review and approve gate checkpoints, and inspect the generated
codebase artifacts.

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | >= 18.17.0 |
| npm | >= 9.0 (or pnpm / yarn equivalent) |
| DevFlow backend | Running on `http://localhost:4000` |

The backend must be running before starting the dashboard. The dashboard makes REST calls and
opens a WebSocket connection to the backend on startup.

---

## Environment Variables

Copy `.env.local.example` to `.env.local` in the `devflow-dashboard/` root and fill in the
values:

```bash
cp .env.local.example .env.local
```

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000/api/v1` | REST API base URL (no trailing slash) |
| `NEXT_PUBLIC_WS_URL` | `http://localhost:4000` | WebSocket server root URL |

The `NEXT_PUBLIC_` prefix is required by Next.js — these variables are inlined at build time
into client-side JavaScript. Do not put secrets in `NEXT_PUBLIC_` variables.

---

## Running Locally

```bash
# 1. Navigate to the dashboard folder
cd devflow-dashboard

# 2. Install dependencies
npm install

# 3. Copy and configure environment
cp .env.local.example .env.local
# Edit .env.local if your backend runs on a different port or host

# 4. Start the dev server
npm run dev
```

The dashboard will be available at `http://localhost:3000`.

To run type checking separately:

```bash
npm run type-check
```

To build for production:

```bash
npm run build
npm run start
```

---

## Page Map

| Route | Component | Description |
|-------|-----------|-------------|
| `/` | `app/page.tsx` | Brief submission form. Enter company name, project brief, and select a stack. Posts to `POST /api/v1/projects` and redirects to the project status page. |
| `/projects/[id]` | `app/projects/[id]/page.tsx` | Real-time project status dashboard. Shows pipeline progress, gate review panels, and error display. Connects via WebSocket for live updates. |
| `/projects/[id]/artifacts` | `app/projects/[id]/artifacts/page.tsx` | Artifact diff viewer. Server-rendered. Lists generated files on the left; displays raw content on the right in a monospace code block. |

---

## WebSocket Connection

The dashboard uses `socket.io-client` to subscribe to project status events from the backend.

### Connection details

- **URL**: `ws://localhost:4000/devflow` (configurable via `NEXT_PUBLIC_WS_URL`)
- **Namespace**: `/devflow`
- **Transport**: WebSocket (with socket.io fallback to HTTP long-poll)

### Subscription flow

1. On mount of `app/projects/[id]/page.tsx`, the client calls `subscribeToProject(projectId, handler)`.
2. `lib/socket.ts` opens the socket.io connection if not already open, then emits:
   ```json
   { "event": "subscribe", "data": { "projectId": "<id>" } }
   ```
3. The backend acknowledges and begins emitting `project:status` events.
4. The client receives events with shape:
   ```typescript
   {
     projectId: string;
     status: ProjectStatus;
     currentNode: string | null;
     error: string | null;
   }
   ```
5. On page unmount, `unsubscribeFromProject(projectId)` emits an unsubscribe event and removes the listener.
6. A REST polling fallback runs every 5 seconds in parallel, ensuring UI correctness if the WebSocket drops.

### Socket singleton

`lib/socket.ts` exports a module-level singleton. The socket is created once per browser session
and reused across route navigations. It connects lazily (only when `subscribeToProject` is called)
and disconnects when the user leaves the status page.

---

## REST API Integration

All REST calls are centralised in `lib/api.ts`. Components never call `fetch` directly.

| Function | HTTP | Endpoint | Usage |
|----------|------|----------|-------|
| `createProject(data)` | POST | `/projects` | Home page form submit |
| `getProjectStatus(id)` | GET | `/projects/:id/status` | Initial load + polling |
| `reviewGate(id, gate, body)` | POST | `/projects/:id/gate/:gate` | Gate panel approve/reject |
| `getArtifacts(id)` | GET | `/projects/:id/artifacts` | Artifacts page + gate 2 summary |

All functions throw a typed `Error` with the server's `message` field on non-2xx responses.
Components catch these errors and display user-facing messages.

---

## Component Reference

| Component | File | Description |
|-----------|------|-------------|
| `StatusBadge` | `components/StatusBadge.tsx` | Maps `ProjectStatus` to a coloured badge. Animated dot on active statuses. |
| `ProgressSteps` | `components/ProgressSteps.tsx` | 7-step pipeline tracker. Steps are `completed`, `active`, or `pending` based on current status. |
| `GatePanel` | `components/GatePanel.tsx` | Approve/reject panel for Gate 1 and Gate 2. Gate 2 panel shows artifact file summary. |
| `ArtifactViewer` | `components/ArtifactViewer.tsx` | File list + code content pane. No external syntax highlighter — monospace with dark background. |

---

## Pipeline Status Reference

| Status | Meaning |
|--------|---------|
| `PENDING` | Project created, not yet processed |
| `PARSING` | Parser agent extracting requirements from brief |
| `GENERATING` | Backend, frontend, and infrastructure agents running |
| `AWAITING_GATE_1` | Waiting for human review of the technical contract |
| `AWAITING_GATE_2` | Waiting for human review of generated code artifacts |
| `DELIVERING` | Commit agent writing files to repository |
| `DELIVERED` | Pipeline complete — artifacts available |
| `FAILED` | An agent node encountered an unrecoverable error |

---

## Project Structure

```
devflow-dashboard/
├── app/
│   ├── globals.css              Global styles, Tailwind base, scrollbar, focus ring
│   ├── layout.tsx               Root layout: Inter font, dark bg, skip link, header, footer
│   ├── page.tsx                 Brief submission form (client component)
│   └── projects/
│       └── [id]/
│           ├── page.tsx         Status dashboard (client component, WebSocket + polling)
│           └── artifacts/
│               └── page.tsx     Artifact viewer (server component, REST fetch)
├── components/
│   ├── ArtifactViewer.tsx       File list + content pane
│   ├── GatePanel.tsx            Gate review form
│   ├── ProgressSteps.tsx        Pipeline step tracker
│   └── StatusBadge.tsx          Coloured status indicator
├── lib/
│   ├── api.ts                   Typed REST wrappers + TypeScript interfaces
│   └── socket.ts                socket.io-client singleton + subscribe/unsubscribe helpers
├── .env.local.example           Environment variable template
├── next.config.ts               Next.js configuration
├── tailwind.config.ts           Tailwind theme extension (colors, fonts, animations)
├── tsconfig.json                TypeScript strict mode configuration
└── postcss.config.js            PostCSS with Tailwind and Autoprefixer
```

---

## Accessibility

- Skip-to-content link as first focusable element in `<body>`
- All interactive elements have `:focus-visible` rings
- `aria-label`, `aria-invalid`, `aria-describedby` applied on form fields
- Gate panel buttons labeled with `aria-label`
- `prefers-reduced-motion` respected via global CSS — all CSS animations are disabled when set
- Minimum input `font-size: 16px` to prevent iOS zoom on focus
- Touch targets minimum 44x44px on all buttons

---

## Known Limitations

1. The artifact viewer does not apply syntax highlighting — content is displayed as plain text in a monospace block.
2. The WebSocket connection does not attempt reconnection on drop beyond socket.io's built-in reconnect logic. The polling fallback compensates.
3. Artifact fetching on the status page is best-effort — if the backend has not yet written artifacts, the request silently returns an empty array.

---

*Alphaexplora Capstone — AI Orchestration System v1*
