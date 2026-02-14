# Agent Development Guide

## Quick Reference

- `npm run dev` — start server with auto-restart (serves API + static files on :3000)
- `npm run test` — run all tests (node --test)
- `npm run check` — lint + test (run before committing)

## Project Structure

```
codebuilder/
├── AGENTS.md                        # This file — mandatory reading
├── docs/
│   ├── architecture.md              # System overview, data model, API surface
│   └── design.md                    # Project conventions and structure
│
├── server/                          # Express + WebSocket backend
│   ├── index.js                     # Server entry: Express + WS setup, route mounting
│   ├── store.js                     # SQLite data layer (tasks, task_events)
│   ├── scheduler.js                 # Task scheduling loop, dependency resolution
│   ├── worker.js                    # Claude SDK wrapper, one instance per running task
│   ├── validation.js                # Zod schemas for REST/WS message validation
│   ├── docs/                        # Data flow documentation (mermaid diagrams)
│   │   ├── task-lifecycle.md
│   │   ├── worker-streaming.md
│   │   └── plan-review-flow.md
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
│   │   └── render.js                # Shared DOM helpers (createElement shortcuts, markdown)
│   └── docs/                        # Frontend data flow documentation
│       ├── state-management.md
│       └── event-rendering.md
│
└── package.json
```

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
