# Unified App Architecture

## Overview

Codebuilder merges two previously independent systems into a single application:

- **Task Orchestration** (Claude Agent SDK headless tasks, kanban board, plan-then-execute)
- **Terminal** (Claude Code CLI via PTY, xterm.js split panes, session management)

One server, one port, one frontend. Projects are the shared top-level entity.

---

## Server Architecture

### Single Entry Point: `server/index.js` (port 3000)

```
┌─────────────────────────────────────────────────────┐
│  Express App (port 3000)                            │
│                                                     │
│  Static: public/                                    │
│  Static: /vendor/xterm* → node_modules/@xterm/*     │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ Task Routes (/api/tasks/*)                  │    │
│  │ - GET    /api/tasks(?projectId=xxx)         │    │
│  │ - POST   /api/tasks                         │    │
│  │ - GET    /api/tasks/:id                     │    │
│  │ - PATCH  /api/tasks/:id                     │    │
│  │ - POST   /api/tasks/:id/confirm             │    │
│  │ - POST   /api/tasks/:id/revise              │    │
│  │ - GET    /api/tasks/:id/events              │    │
│  │ - GET    /api/health                        │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ Terminal Routes (terminal/routes.js)         │    │
│  │ - GET    /api/projects                      │    │
│  │ - POST   /api/projects                      │    │
│  │ - DELETE /api/projects/:id                  │    │
│  │ - GET    /api/projects/:id/sessions         │    │
│  │ - GET    /api/projects/:id/claude-sessions  │    │
│  │ - DELETE /api/projects/:id/sessions/:sid    │    │
│  │ - GET/PUT/POST /api/slack*                  │    │
│  │ - GET    /api/fs                            │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  ┌──────────────── HTTP Upgrade ────────────────┐   │
│  │ /ws          → Codebuilder WSS (broadcast)   │   │
│  │ /ws/terminal → Terminal WSS (per-session PTY) │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Backward-Compatible Terminal: `terminal/server.js` (port 4000)

A thin wrapper that imports `terminal/routes.js` and `server/store.js`:

```
┌───────────────────────────────────────┐
│  Express App (port 4000)              │
│  Static: terminal/public/             │
│  Routes: terminal/routes.js           │
│  WS: /ws/terminal only                │
│  Store: shared SQLite via getStore()  │
└───────────────────────────────────────┘
```

Both servers share the same SQLite database (WAL mode handles concurrent access).
They have independent PTY session pools (in-memory per process).

### WebSocket Protocols

**Codebuilder WS (`/ws`)** — broadcast protocol:

- Server → Client: `{type: 'task:updated', task}`, `{type: 'task:event', taskId, event}`, `{type: 'task:approval', taskId, event}`
- Client → Server: `{type: 'approve', taskId, eventId, allow}`

**Terminal WS (`/ws/terminal`)** — per-session protocol:

- Client → Server (first msg): `{type: 'attach', projectId, sessionType, cols, rows, claudeSessionId?}`
- Client → Server: `{type: 'input', data}`, `{type: 'resize', cols, rows}`, `{type: 'ping', id}`, `{type: 'restart', cols, rows}`
- Server → Client: `{type: 'output', data}`, `{type: 'history', data}`, `{type: 'exit', exitCode, signal}`, `{type: 'pong', id}`

---

## Data Model

### SQLite Schema (`server/store.js`)

```sql
projects (
  id         TEXT PRIMARY KEY,    -- ULID (or UUID for migrated)
  name       TEXT NOT NULL,
  cwd        TEXT NOT NULL,
  created_at INTEGER NOT NULL
)

tasks (
  id          TEXT PRIMARY KEY,   -- ULID
  seq         INTEGER,            -- display ordering
  title       TEXT NOT NULL,
  type        TEXT DEFAULT 'task', -- 'task' | 'plan'
  status      TEXT DEFAULT 'pending', -- pending|running|review|done|failed|cancelled
  cwd         TEXT NOT NULL,
  project_id  TEXT REFERENCES projects(id),  -- NEW: links task to project
  depends_on  TEXT REFERENCES tasks(id),
  plan_result TEXT,
  feedback    TEXT,
  turns       INTEGER DEFAULT 0,
  cost_usd    REAL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  ended_at    INTEGER
)

task_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT REFERENCES tasks(id),
  kind       TEXT NOT NULL,       -- text|tool_use|tool_result|error|approval_req
  data       TEXT NOT NULL,       -- JSON
  created_at INTEGER NOT NULL
)
```

**Key relationships:**

- Tasks belong to projects via `project_id` (optional for backward compat)
- Tasks can depend on other tasks via `depends_on`
- Task events are append-only log per task

### Project Migration

On first startup, `store.migrateProjectsJson()` reads `terminal/projects.json`,
imports rows into the `projects` table (preserving original UUIDs), and renames
the file to `.bak`. `store.ensureStarterProject()` creates a default project
from `process.cwd()` if the table is empty.

---

## Frontend Architecture

### Layout

```
┌──────────┬──────────────────────────────────────────┐
│ SIDEBAR  │ HEADER: Codebuilder    [status badges]   │
│          ├──────────────────────────────────────────┤
│ [Proj 1] │ TAB BAR: [Tasks] [Terminal]              │
│ [Proj 2] ├──────────────────────────────────────────┤
│ [Proj 3] │                                          │
│          │   Tasks tab: kanban board                 │
│ [+ Add]  │   Terminal tab: split bash/claude panes   │
│          │                                          │
└──────────┴──────────────────────────────────────────┘
```

Desktop: sidebar always visible (240px, collapsible).
Mobile: sidebar as bottom sheet via hamburger button.

### Module Structure

```
public/js/
├── app.js              # Orchestrator: init, connect WS, wire modules
├── state.js            # Shared state: projects, activeProjectId, activeTab, tasks, events
├── api.js              # REST fetch wrappers (tasks + projects)
├── ws.js               # Codebuilder WebSocket (task events/approvals)
├── sidebar.js          # Project list UI, add/delete project dialog
├── tab-bar.js          # Tab switching, lazy terminal init
├── task-form.js        # Task creation form (uses active project's cwd)
├── task-board.js       # Kanban board renderer
├── task-card.js        # Individual task card
├── task-detail.js      # Event stream panel
├── plan-review.js      # Plan review panel
├── render.js           # DOM helpers, markdown, formatters
├── terminal-view.js    # Terminal tab controller (panes, sessions, input bar)
├── terminal-pane.js    # xterm + WebSocket + PTY bridge
├── split-pane.js       # Draggable divider
└── local-echo.js       # Local echo prediction
```

### State Management

```js
state = {
  projects: [], // All projects from SQLite
  activeProjectId: null, // Currently selected project
  activeTab: 'tasks', // 'tasks' | 'terminal'
  tasks: [], // Tasks for active project
  events: new Map(), // taskId → event[]
  selectedTaskId: null, // Task detail/plan review
}
```

State mutations trigger targeted re-renders (no virtual DOM).
WebSocket messages and REST responses mutate state directly.

### Data Flow

```
User selects project in sidebar
  → state.activeProjectId = id
  → fetch GET /api/tasks?projectId=id
  → state.tasks = response
  → renderBoard()
  → if terminal initialized: terminalView.switchProject(id)

User switches to Terminal tab
  → state.activeTab = 'terminal'
  → if first visit: terminalView.init(state.activeProjectId)
  → else: terminalView.fitTerminals()

User creates a task
  → POST /api/tasks { title, type, projectId }
  → server resolves cwd from project
  → WS broadcasts task:updated → state.taskUpdated(task) → renderBoard()

Terminal pane connects
  → WS to /ws/terminal
  → sends { type: 'attach', projectId, sessionType, cols, rows }
  → server creates/reuses PTY session
  → bidirectional I/O streaming
```

### CSS Architecture

Single `public/style.css` merging both design systems:

- Shared design tokens (identical palette, glass layers, radii)
- System font stack (no external @import for performance)
- Component styles: header, sidebar, tab-bar, board, cards, panels, terminals
- Mobile: sidebar → hamburger/bottom sheet, kanban → collapsible columns
- xterm overrides, iOS scroll fixes

---

## PM2 Configuration

```
ecosystem.config.cjs:
  codebuilder → server/index.js (port 3000) — unified app
  terminal    → terminal/server.js (port 4000) — backward compat
```

Both processes can run simultaneously. They share the SQLite database
but maintain independent PTY session pools.

---

## File Changes Summary

### Phase 1+2 (Backend) — DONE

| Action  | File                   | Description                                                |
| ------- | ---------------------- | ---------------------------------------------------------- |
| Create  | `terminal/routes.js`   | Extracted terminal Router + WS handler                     |
| Rewrite | `server/index.js`      | Unified entry: tasks + terminal + dual WS                  |
| Rewrite | `server/store.js`      | Added projects table, CRUD, migration, project_id on tasks |
| Modify  | `server/validation.js` | Added optional projectId to CreateTaskSchema               |
| Rewrite | `terminal/server.js`   | Thin wrapper importing routes.js + store                   |

### Phase 3 (Frontend)

| Action  | File                         | Description                                |
| ------- | ---------------------------- | ------------------------------------------ |
| Copy    | `public/js/terminal-pane.js` | From terminal/public/js/                   |
| Copy    | `public/js/split-pane.js`    | From terminal/public/js/                   |
| Copy    | `public/js/local-echo.js`    | From terminal/public/js/                   |
| Create  | `public/js/sidebar.js`       | Project list, add/delete, active indicator |
| Create  | `public/js/tab-bar.js`       | Tab switching, lazy terminal init          |
| Create  | `public/js/terminal-view.js` | Terminal tab controller                    |
| Rewrite | `public/index.html`          | Sidebar + tabs + terminal markup           |
| Rewrite | `public/js/app.js`           | Unified orchestrator                       |
| Modify  | `public/js/state.js`         | Add projects, activeProjectId, activeTab   |
| Modify  | `public/js/api.js`           | Add project CRUD wrappers                  |
| Modify  | `public/js/task-form.js`     | Use project cwd, add projectId             |
| Modify  | `public/js/ws.js`            | Connect to /ws path                        |
| Merge   | `public/style.css`           | Both CSS files + sidebar/tab styles        |

### Kept (backward compat)

| File                         | Purpose                            |
| ---------------------------- | ---------------------------------- |
| `terminal/public/index.html` | Standalone terminal UI on :4000    |
| `terminal/public/style.css`  | Standalone terminal styles         |
| `terminal/public/js/*`       | Standalone terminal JS (unchanged) |
