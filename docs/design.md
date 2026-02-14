# Codebuilder — Project Design

How this project is structured for agent legibility and robustness, adapted from [example-app](../README.md).

---

## Project Structure

```
codebuilder/
├── AGENTS.md                        # Agent development guide (mandatory reading)
├── docs/
│   ├── architecture.md              # System overview, data model, API surface
│   └── design.md                    # This file — project conventions and structure
│
├── server/                          # Express + WebSocket backend
│   ├── index.js                     # Server entry: Express + WS setup, route mounting
│   ├── store.js                     # SQLite data layer (tasks, task_events)
│   ├── scheduler.js                 # Task scheduling loop, dependency resolution
│   ├── worker.js                    # Claude SDK wrapper, one instance per running task
│   ├── validation.js                # Zod schemas for REST/WS message validation
│   ├── docs/                        # ★ Data flow documentation (mermaid diagrams)
│   │   ├── task-lifecycle.md        # Task state machine, status transitions
│   │   ├── worker-streaming.md      # SDK → event log → WebSocket → client flow
│   │   └── plan-review-flow.md      # Plan creation → review → execution cycle
│   └── tests/                       # Co-located server tests
│       ├── store.test.js
│       ├── scheduler.test.js
│       └── worker.test.js
│
├── public/                          # Vanilla JS frontend (no build step)
│   ├── index.html                   # Single page shell, loads app.js
│   ├── style.css                    # Design tokens + component styles
│   ├── js/
│   │   ├── app.js                   # Entry: WS connection, state, view routing
│   │   ├── state.js                 # Mutable state object + render dispatch
│   │   ├── ws.js                    # WebSocket connection, reconnect, message dispatch
│   │   ├── api.js                   # REST helpers (fetch wrappers)
│   │   ├── task-form.js             # Renders create-task form, handles submit
│   │   ├── task-board.js            # Renders kanban columns, filters by status
│   │   ├── task-card.js             # Renders a single task summary card
│   │   ├── task-detail.js           # Renders event stream, tool calls, approval UI
│   │   ├── plan-review.js           # Renders markdown plan, confirm/revise actions
│   │   └── render.js               # Shared DOM helpers (createElement shortcuts, markdown)
│   └── docs/                        # ★ Frontend data flow documentation
│       ├── state-management.md      # State shape, WS dispatch, initial load
│       └── event-rendering.md       # How task_events map to UI elements
│
└── package.json
```

### Key Structural Decisions

**Domain-organized, not layer-organized.** Server docs live in `server/docs/`, frontend docs in `public/docs/`. Tests are co-located with the code they test. No top-level `tests/` or `docs/` that mirror the source tree — documentation lives next to the code it describes.

**Flat server directory.** Four files (`index.js`, `store.js`, `scheduler.js`, `worker.js`) plus `validation.js`. No `routes/`, `middleware/`, `services/` subdirectories — the app is small enough that one level is clearer. If a file exceeds ~400 lines, split by responsibility, not by layer.

**No build step.** The `public/` directory is served directly by Express as static files. Vanilla ES modules, a single CSS file, and CDN-loaded dependencies (`marked`, `DOMPurify`). No bundler, no transpiler, no source maps. See [architecture.md](./architecture.md#frontend-technology-evaluation) for the rationale.

**Docs as first-class code.** The `docs/` directories inside `server/` and `public/` are not optional. Every non-trivial interaction gets a mermaid diagram before the code is written.

---

## Documentation Requirements

Adopted from example-app's documentation discipline.

### What Must Be Documented

Every interaction that crosses a boundary (client ↔ server, scheduler ↔ worker, store ↔ caller) needs a data flow doc with:

1. **State ownership diagram** — what lives in SQLite vs. worker memory vs. client `state.js`
2. **Request/response flow** — the sequence of REST calls, WebSocket messages, and state transitions
3. **Error paths** — what happens when a worker fails, a WebSocket disconnects, or a task is cancelled mid-flight

### Mermaid Diagrams

Use `sequenceDiagram` for request/response flows, `stateDiagram-v2` for lifecycle transitions, `flowchart` for data ownership.

Example from `server/docs/task-lifecycle.md`:

```markdown
## Task State Machine

​```mermaid
stateDiagram-v2
    [*] --> pending: POST /api/tasks
    pending --> running: scheduler.tick()
    running --> done: worker completes (type=task)
    running --> review: worker completes (type=plan)
    running --> failed: worker error / SDK crash
    review --> pending: POST /api/tasks/:id/revise
    review --> pending: POST /api/tasks/:id/confirm (creates new task)
    failed --> pending: PATCH /api/tasks/:id (retry)
    pending --> cancelled: PATCH /api/tasks/:id
    running --> cancelled: PATCH /api/tasks/:id (aborts worker)
​```
```

Example from `server/docs/worker-streaming.md`:

```markdown
## Event Streaming Flow

​```mermaid
sequenceDiagram
    participant SDK as Claude SDK
    participant W as Worker
    participant S as Store
    participant WS as WebSocket
    participant UI as Browser

    SDK->>W: onText(chunk)
    W->>S: appendEvent(taskId, 'text', {text})
    S-->>W: event (with id)
    W->>WS: broadcast({type: 'task:event', taskId, event})
    WS->>UI: JSON message
    UI->>UI: dispatch EVENT_RECEIVED
​```
```

### Architecture Backlinks

Every module and exported function must include an `Architecture:` comment pointing to the relevant doc and section anchor. This creates a bidirectional link — docs describe the design, code points back to the docs.

**Module-level:**

```js
/**
 * Task scheduling loop.
 *
 * Picks pending tasks, checks dependency resolution, starts workers
 * up to MAX_CONCURRENCY.
 *
 * Architecture: server/docs/task-lifecycle.md#scheduling
 */
```

**Function-level:**

```js
/**
 * Start a worker for a task.
 *
 * Architecture: server/docs/worker-streaming.md#worker-startup
 */
export function startWorker(task, broadcast) { ... }
```

**Frontend module-level:**

```js
/**
 * Renders the live event stream for a running task.
 *
 * Appends events to the stream container as they arrive via WebSocket.
 * Replays stored events on view activation, then appends new ones live.
 *
 * Architecture: public/docs/event-rendering.md#task-detail
 */
```

---

## Validation at Boundaries

All data entering the server is validated with Zod schemas in `server/validation.js`. This is the single source of truth for message shapes — both REST bodies and WebSocket messages.

```js
// server/validation.js

import { z } from 'zod'

/** POST /api/tasks — Architecture: docs/architecture.md#rest-task-crud */
export const CreateTaskSchema = z.object({
  title: z.string().min(1),
  type: z.enum(['task', 'plan']).default('task'),
  cwd: z.string().min(1),
  dependsOn: z.string().optional(),
})

/** PATCH /api/tasks/:id — Architecture: docs/architecture.md#rest-task-crud */
export const UpdateTaskSchema = z.object({
  status: z.enum(['cancelled', 'pending']).optional(),
  feedback: z.string().optional(),
})

/** Client → Server WS — Architecture: docs/architecture.md#websocket */
export const WsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('approve'),
    taskId: z.string(),
    eventId: z.number(),
    allow: z.boolean(),
  }),
])

/** Server → Client WS (for documentation — not validated at send) */
export const WsServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('task:updated'), task: z.any() }),
  z.object({ type: z.literal('task:event'), taskId: z.string(), event: z.any() }),
  z.object({ type: z.literal('task:approval'), taskId: z.string(), event: z.any() }),
])
```

Route handlers call `schema.parse(req.body)` at the top. WebSocket `onmessage` calls `WsClientMessageSchema.parse(JSON.parse(data))`. Validation errors return 400 with the Zod error message. No manual type checking elsewhere.

---

## Code Conventions

### Naming by Function, Not Location

Name things by what they do, not where they appear.

- `TaskCard` — what it renders (a card summarizing a task)
- `PlanReview` — what the user does (review a plan)
- `appendEvent` — what it does (appends an event)
- Not: `SidebarItem`, `ModalContent`, `dbInsert`

### No Lazy Deprecation

Never mark code as "deprecated". Find all callers, migrate them, delete the code. Dead code is noise for agents.

### Module Size Guideline

If a file exceeds ~400 lines, it probably has two responsibilities. Split by function:

- `worker.js` handles SDK integration → if approval logic grows complex, extract `approval.js`
- `task-detail.js` renders events → if tool-call rendering grows complex, extract `tool-call-renderer.js`

But do not pre-split. Start with the flat structure and split only when a file becomes hard to reason about.

### Error Handling

Errors in workers are caught, logged as a `task_event` of kind `'error'`, and the task status is set to `'failed'`. The client renders these events inline in the task detail view. No separate error modals, no toast system — the event log is the single source of truth.

```js
// In worker.js
try {
  await this.sdk.run()
} catch (err) {
  store.appendEvent(this.task.id, 'error', { message: err.message })
  store.updateTask(this.task.id, { status: 'failed', ended_at: Date.now() })
  this.broadcast({ type: 'task:updated', task: store.getTask(this.task.id) })
}
```

---

## Testing Strategy

### Server Tests (co-located)

```
server/tests/
├── store.test.js       # CRUD operations, event appending, incremental fetch
├── scheduler.test.js   # Dependency resolution, concurrency limits
└── worker.test.js      # SDK mock, event emission, approval flow
```

Run with: `npm test`

**Store tests** use an in-memory SQLite database (`:memory:`). No fixtures, no teardown — each test gets a fresh DB.

**Scheduler tests** mock the store and worker pool. Verify that:
- Blocked tasks (unresolved `depends_on`) are skipped
- `MAX_CONCURRENCY` is respected
- Completed dependencies unblock waiting tasks

**Worker tests** mock the Claude SDK. Verify that:
- Text chunks produce `text` events
- Tool calls produce `tool_use` or `approval_req` events
- Completion sets correct status (`done` vs `review`)
- Errors set status to `failed`
- `abort()` terminates the SDK session

### Frontend Tests

Deferred until the UI stabilizes. When added, use Playwright for E2E tests following the example-app pattern:
- Co-located in `public/tests/`
- Visual regression with screenshot comparison
- Test the full lifecycle: create task → watch stream → approve tool → see completion

---

## Guardrails

### Pre-commit (via lint-staged + husky)

| Check | Tool | Purpose |
|-------|------|---------|
| Format | Prettier | Consistent style, no debates |
| Lint | ESLint | Catch bugs, enforce conventions |

No TypeScript — vanilla JS with JSDoc annotations. No type-check step, but ESLint catches most structural errors.

### npm Scripts

```json
{
  "scripts": {
    "dev": "node --watch server/index.js",
    "test": "node --test server/tests/",
    "lint": "eslint server/ public/js/ && prettier --check .",
    "check": "npm run lint && npm run test"
  }
}
```

`npm run check` runs all guardrails. `npm run dev` uses Node's built-in `--watch` for auto-restart — no `nodemon`, no `concurrently`, no Vite. The frontend is static files served by Express, so there's nothing to build or hot-reload.

---

## State Management (Frontend)

Single mutable state object in `public/js/state.js`. No framework, no reducer, no immutability discipline. WebSocket messages mutate state directly and call the affected render function.

```
public/docs/state-management.md should document:

1. State shape:
   { tasks: Task[], events: Map<taskId, Event[]>, selectedTaskId: string | null }

2. Mutation sources:
   - REST response (initial load) → state.tasks = data
   - WebSocket message → taskUpdated(task), eventReceived(taskId, event)
   - User interaction → state.selectedTaskId = id; renderDetail()

3. Initial load sequence:
   GET /api/tasks → populate state.tasks, call renderBoard()
   For each running task: GET /api/tasks/:id/events → populate state.events
   WebSocket connected → live updates begin

4. Reconnection:
   On WS disconnect, re-fetch all tasks + events for running tasks.
   Events have monotonic IDs, so incremental fetch (?after=lastEventId)
   avoids duplicates.

5. Why mutable state:
   No virtual DOM diffing — we call renderBoard() or appendEventToStream()
   explicitly. Mutable state eliminates the entire class of stale-closure
   and immutable-update bugs that plague React codegen.
```

---

## AGENTS.md Skeleton

The root `AGENTS.md` file serves as the entry point for any coding agent. It should contain:

```markdown
# Agent Development Guide

## Quick Reference

- `npm run dev` — start server with auto-restart (serves API + static files)
- `npm run test` — run all tests
- `npm run check` — lint + test (run before committing)

## Project Structure

[diagram from this file's Project Structure section]

## Reference Patterns

The initial implementation is the reference. Study these files before modifying:

- **server/store.js** — data layer pattern (prepared statements, JSDoc, Architecture backlinks)
- **server/worker.js** — SDK integration pattern (event emission, error handling, approval flow)
- **public/js/task-detail.js** — event rendering pattern (DOM append, per-event renderers)
- **public/js/state.js** — state management pattern (mutable state + explicit render calls)

## Documentation Requirements

All non-trivial interactions must have data flow docs with mermaid diagrams.
Every module and exported function must have an Architecture backlink.
See docs/design.md for full conventions.

## Design Principles

- Name by function, not location
- No lazy deprecation — delete dead code
- Validate at boundaries (Zod schemas in server/validation.js)
- Errors are events — the event log is the single source of truth
- Split files only when they exceed ~400 lines
- No build step — frontend is vanilla ES modules served as static files
- Mutable state, explicit renders — no framework magic between intent and DOM

## Skills

[To be added as .claude/skills/ guides when patterns stabilize]
- server-guide: Store, scheduler, worker patterns
- frontend-guide: DOM rendering, state management, event streaming
- testing-guide: Test structure, mocks, what to verify
```

---

## .claude/skills/ (Planned)

Following example-app's pattern, agent skill guides will be added as the codebase stabilizes. Each guide lives in `.claude/skills/<name>/SKILL.md` with a YAML frontmatter header.

**Planned skills:**

| Skill | Purpose |
|-------|---------|
| `server-guide` | Store API, scheduler behavior, worker lifecycle, SDK integration |
| `frontend-guide` | DOM rendering, state mutations, WS message handling, event stream |
| `testing-guide` | Test structure, mocking patterns, what each test file covers |
| `validation-guide` | Zod schema conventions, where to add new schemas, error responses |

Skills are written after the initial implementation ships — not before. They document what exists, not what's aspirational.

---

## Dependency on architecture.md

This document describes **how** code is organized and **what conventions** to follow. The [architecture document](./architecture.md) describes **what** the system does — the data model, API surface, component diagram, and task lifecycle.

Both documents must stay in sync. When the architecture changes, update `architecture.md` first, then update this document if conventions are affected.
