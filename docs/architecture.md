# Claude Code Task Orchestrator — Architecture Proposal

A minimal web app that dispatches, views, and orchestrates Claude Code tasks.

## Design Philosophy

Take the **task orchestration model** from voice-doc's DevPage (kanban board, plan-then-execute, dependencies) and the **Claude SDK streaming** from claudecodeui (WebSocket, tool approvals, real-time output). Strip everything else.

Choose technologies that minimize LLM codegen failure modes. Prefer explicit over implicit, mutable over immutable-by-convention, and imperative DOM over declarative frameworks — because those are the axes where LLM-generated code breaks silently.

---

## Frontend Technology Evaluation

### Why Not React

React is the default choice for web UIs, but this project is built and maintained by LLM coding agents. React's programming model has specific failure modes that are **subtle, silent, and hard to diagnose** — exactly the category of bugs that LLMs produce most and catch least.

#### LLM codegen failure modes with React

**1. Stale closures in WebSocket handlers (critical for this app)**

Our primary data path is WebSocket → state → render. This is the single hardest pattern to get right in React:

```jsx
// BUG: LLMs write this naturally, and it compiles and runs without errors.
// But `tasks` is captured at mount time and never updates.
useEffect(() => {
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data)
    setTasks([...tasks, data.task])  // `tasks` is stale — always []
  }
}, [])
```

The correct version requires functional `setState` — a non-obvious pattern that LLMs frequently miss:

```jsx
setTasks(prev => upsert(prev, data.task))  // correct but easy to forget
```

With mutable state, this bug category doesn't exist:

```js
// Vanilla: state.tasks is always current, no closure trap
state.tasks = upsert(state.tasks, data.task)
renderBoard()
```

**2. `useEffect` dependency arrays**

LLMs routinely get these wrong. Missing deps → stale data. Extra deps → infinite re-render loops. The "fix" (eslint-disable) silences the lint rule without solving the bug.

**3. Immutable update discipline**

React requires new object references for state updates. LLMs produce `tasks.push(newTask)` (mutation — won't trigger re-render) almost as often as `[...tasks, newTask]` (correct). The bug is silent — the state updates but the UI doesn't.

**4. Conditional hooks**

LLMs occasionally place `useState` or `useEffect` inside conditions or loops, violating the Rules of Hooks. This crashes at runtime with a cryptic error about hook order.

**5. Build toolchain as attack surface**

React requires JSX transform (Vite/Babel), a dev server, HMR configuration, and Tailwind plugin setup. Each is a file an agent can misconfigure. A Vite config error doesn't break at the line that's wrong — it produces an opaque build failure.

**6. Ecosystem version confusion**

LLM training data contains React class components, hooks with `componentDidMount` patterns, react-router v5/v6/v7 mixed syntax, and multiple state management paradigms. Agents import from the wrong version's API without realizing it.

#### What React is good at (and why it still doesn't apply here)

React excels at: large component trees, complex re-render optimization, reusable component libraries, team coordination via type-safe props. **None of these apply.** This app has 6 views, one developer (an LLM), no component reuse across projects, and an append-only event stream that doesn't benefit from virtual DOM diffing.

### Why Vanilla JS

Vanilla JS failure modes are **obvious and loud**. A null element throws immediately. A missing event listener means nothing happens (easy to spot in testing). There are no framework-specific gotchas hiding between the developer's intent and the browser's execution.

For this app specifically:

| Concern | React approach | Vanilla approach | Winner |
|---------|---------------|-----------------|--------|
| WebSocket → UI | `useEffect` + `useRef` + functional `setState` (3 patterns that must be correct simultaneously) | `ws.onmessage` + mutate state + call render (linear, no traps) | **Vanilla** |
| Event stream (append-only) | Re-renders entire list on each event, needs virtualization for long streams | `container.appendChild(renderEvent(evt))` — O(1) per event | **Vanilla** |
| Kanban board (filter + render) | JSX map with key props (agents misuse index keys) | `column.innerHTML = ''; tasks.filter(...).forEach(t => column.appendChild(renderCard(t)))` | **Tie** |
| Markdown rendering | `react-markdown` component | `marked.parse(text)` + `DOMPurify.sanitize()` | **Tie** |
| Build/config | Vite + JSX + Tailwind plugin | `<script type="module">` + `<link>` to CSS file. Zero config. | **Vanilla** |
| Agent modifiability | Must understand hooks rules, closure semantics, immutable updates | Must understand DOM API, event listeners, innerHTML vs textContent | **Vanilla** (DOM API is more stable and better documented in training data) |

### The chosen stack

**Vanilla ES modules** served by Express as static files. No build step.

- **Rendering**: DOM API (`createElement`, `textContent`, `appendChild`, `innerHTML` with DOMPurify)
- **State**: Plain mutable object. One source of truth. Render functions read from it.
- **Markdown**: `marked` (CDN or vendored) + `DOMPurify` for XSS safety
- **Styling**: Single CSS file with design tokens (CSS custom properties). No Tailwind — utility classes add a build step and configuration surface.
- **Cleanup**: `AbortController` pattern from example-app for event listener lifecycle

---

## System Overview

```
┌─────────────────────────────────────────────────────────┐
│                      BROWSER                             │
│                                                          │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ TaskForm │  │  TaskBoard   │  │   TaskDetail      │  │
│  │          │  │  (kanban)    │  │   (live stream)   │  │
│  │ - title  │  │              │  │                   │  │
│  │ - plan?  │  │  pending     │  │  - tool calls     │  │
│  │ - deps   │  │  running     │  │  - text output    │  │
│  │ - cwd    │  │  review      │  │  - approvals      │  │
│  │          │  │  done/failed │  │  - cost/turns     │  │
│  └──────────┘  └──────────────┘  └───────────────────┘  │
│                        │                    ▲             │
│                        ▼                    │             │
│                   ┌─────────────────────────┘             │
│                   │   WebSocket (single conn)             │
└───────────────────┼──────────────────────────────────────┘
                    │
┌───────────────────┼──────────────────────────────────────┐
│   SERVER          ▼                                       │
│                                                           │
│  ┌────────────────────────┐    ┌───────────────────────┐  │
│  │     Task Router        │    │   Worker Pool         │  │
│  │                        │    │                       │  │
│  │  REST: CRUD tasks      │    │  Map<taskId, Worker>  │  │
│  │  WS: stream + approvals│    │                       │  │
│  │                        │    │  Worker {             │  │
│  └────────┬───────────────┘    │    sdk: ClaudeSDK     │  │
│           │                    │    status              │  │
│           ▼                    │    turns, cost         │  │
│  ┌────────────────────┐       │    cwd                 │  │
│  │   Scheduler        │──────▶│  }                     │  │
│  │                    │       │                        │  │
│  │  - picks pending   │       │  onText → ws.send()    │  │
│  │  - checks deps     │       │  onToolUse → ws.send() │  │
│  │  - respects max    │       │  onComplete → update() │  │
│  │    concurrency     │       └───────────────────────┘  │
│  └────────────────────┘                                   │
│           │                                               │
│           ▼                                               │
│  ┌────────────────────┐                                   │
│  │   Store (SQLite)   │                                   │
│  │                    │                                   │
│  │  tasks             │                                   │
│  │  task_events       │                                   │
│  └────────────────────┘                                   │
└───────────────────────────────────────────────────────────┘
```

---

## Data Model

Two tables only.

```sql
CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,           -- ulid
  seq         INTEGER AUTOINCREMENT,      -- display order
  title       TEXT NOT NULL,
  type        TEXT DEFAULT 'task',        -- 'task' | 'plan'
  status      TEXT DEFAULT 'pending',     -- pending | running | review | done | failed | cancelled
  cwd         TEXT NOT NULL,              -- working directory for claude
  depends_on  TEXT REFERENCES tasks(id),
  plan_result TEXT,                       -- markdown plan output (for review stage)
  feedback    TEXT,                       -- user feedback on retry/revision
  turns       INTEGER DEFAULT 0,
  cost_usd    REAL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  ended_at    INTEGER
);

CREATE TABLE task_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  kind        TEXT NOT NULL,              -- 'text' | 'tool_use' | 'tool_result' | 'error' | 'approval_req'
  data        TEXT NOT NULL,              -- JSON blob
  created_at  INTEGER NOT NULL
);
```

`task_events` is the append-only log of everything a worker produces. It replaces both the streaming buffer and the history files from voice-doc. The client replays events to render the TaskDetail view.

---

## Server Components

```
server/
├── index.js          # Express + WS setup, routes, static file serving
├── store.js          # SQLite via better-sqlite3, prepared statements
├── scheduler.js      # Picks tasks, manages concurrency
└── worker.js         # Wraps @anthropic-ai/claude-agent-sdk per task
```

### store.js

Thin data layer over SQLite.

```js
export function createTask({ title, type, cwd, dependsOn })
export function getTask(id)
export function listTasks()
export function updateTask(id, fields)
export function appendEvent(taskId, kind, data)
export function getEvents(taskId, afterId?)  // for incremental fetch
```

### scheduler.js

Simple loop that runs every 2 seconds (or on task mutation).

```js
export function tick(workerPool) {
  const pending = store.listTasks().filter(t => t.status === 'pending')
  for (const task of pending) {
    if (task.depends_on) {
      const dep = store.getTask(task.depends_on)
      if (dep.status !== 'done') continue  // skip blocked tasks
    }
    if (workerPool.size >= MAX_CONCURRENCY) break
    workerPool.start(task)
  }
}
```

### worker.js

Claude SDK wrapper. One worker instance per running task.

```js
export class Worker {
  constructor(task, broadcast) {
    this.task = task
    this.broadcast = broadcast  // fn to push WS messages to all clients
  }

  async run() {
    store.updateTask(this.task.id, { status: 'running', started_at: Date.now() })
    this.broadcast({ type: 'task:updated', task: store.getTask(this.task.id) })

    const sdk = new ClaudeSDK({
      cwd: this.task.cwd,
      prompt: this.task.type === 'plan'
        ? `Create a detailed implementation plan (do NOT write code):\n${this.task.title}`
        : this.task.title,
      onText: (text) => {
        const evt = store.appendEvent(this.task.id, 'text', { text })
        this.broadcast({ type: 'task:event', taskId: this.task.id, event: evt })
      },
      onToolUse: (tool) => {
        if (needsApproval(tool)) {
          const evt = store.appendEvent(this.task.id, 'approval_req', { tool })
          this.broadcast({ type: 'task:approval', taskId: this.task.id, event: evt })
          return this.waitForApproval(evt.id)
        }
        const evt = store.appendEvent(this.task.id, 'tool_use', { tool })
        this.broadcast({ type: 'task:event', taskId: this.task.id, event: evt })
        return true
      },
      onComplete: (result) => {
        const finalStatus = this.task.type === 'plan' ? 'review' : 'done'
        store.updateTask(this.task.id, {
          status: finalStatus,
          plan_result: this.task.type === 'plan' ? result : null,
          turns: this.turns,
          cost_usd: this.cost,
          ended_at: Date.now()
        })
        this.broadcast({ type: 'task:updated', task: store.getTask(this.task.id) })
      }
    })
  }

  waitForApproval(eventId) { /* Promise + resolver map */ }
  handleApproval(eventId, approved) { /* resolve the promise */ }
  abort() { /* sdk.abort() */ }
}
```

---

## API Surface

### REST (task CRUD)

| Method  | Path                      | Body                                   | Purpose                            |
|---------|---------------------------|----------------------------------------|------------------------------------|
| `GET`   | `/api/tasks`              | —                                      | List all tasks                     |
| `POST`  | `/api/tasks`              | `{ title, type?, cwd, dependsOn? }`   | Create task                        |
| `PATCH` | `/api/tasks/:id`          | `{ status?, feedback? }`               | Cancel, retry                      |
| `POST`  | `/api/tasks/:id/confirm`  | `{ title? }`                           | Confirm plan, spawn execution task |
| `POST`  | `/api/tasks/:id/revise`   | `{ feedback }`                         | Revise plan, reset to pending      |
| `GET`   | `/api/tasks/:id/events`   | `?after=eventId`                       | Incremental event fetch            |

### WebSocket (single connection, all tasks)

```
Server → Client:
  { type: "task:updated",  task }          // status change
  { type: "task:event",    taskId, event } // text/tool_use streamed
  { type: "task:approval", taskId, event } // needs user decision

Client → Server:
  { type: "approve", taskId, eventId, allow: bool }
```

One connection, messages tagged by `taskId`. The client filters by which task detail panel is open.

---

## Frontend Components

```
public/
├── index.html            # Single page shell, loads app.js
├── style.css             # Design tokens + component styles (no build step)
└── js/
    ├── app.js            # Entry: WS connection, state, routing between views
    ├── state.js          # Mutable state object + render dispatch
    ├── ws.js             # WebSocket connection, reconnect, message dispatch
    ├── api.js            # REST helpers (fetch wrappers)
    ├── task-form.js      # Renders create-task form, handles submit
    ├── task-board.js     # Renders kanban columns, filters by status
    ├── task-card.js      # Renders a single task summary card
    ├── task-detail.js    # Renders event stream, tool calls, approval buttons
    ├── plan-review.js    # Renders markdown plan, confirm/revise actions
    └── render.js         # Shared DOM helpers (createElement shortcuts, markdown)
```

All files are ES modules loaded via `<script type="module" src="/js/app.js">`. No bundler, no transpiler, no source maps to debug.

### State Management

Single mutable state object. Render functions read from it. WebSocket messages mutate it and trigger targeted re-renders.

```js
// state.js

export const state = {
  tasks: [],                    // Task[]
  events: new Map(),            // Map<taskId, Event[]>
  selectedTaskId: null,         // string | null
}

// Mutate + re-render the affected view.
// No immutability discipline needed — there is no virtual DOM diffing.
export function taskUpdated(task) {
  const idx = state.tasks.findIndex(t => t.id === task.id)
  if (idx >= 0) state.tasks[idx] = task
  else state.tasks.push(task)
  renderBoard()
  if (task.id === state.selectedTaskId) renderDetail()
}

export function eventReceived(taskId, event) {
  if (!state.events.has(taskId)) state.events.set(taskId, [])
  state.events.get(taskId).push(event)
  if (taskId === state.selectedTaskId) appendEventToStream(event)
}
```

This eliminates the entire class of stale-closure and immutable-update bugs. The tradeoff — no automatic re-rendering — is acceptable for 6 views where we know exactly which view is affected by each mutation.

### WebSocket Connection

```js
// ws.js

let ws = null
const ac = new AbortController()

export function connect(url) {
  ws = new WebSocket(url)

  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    switch (msg.type) {
      case 'task:updated':  taskUpdated(msg.task); break
      case 'task:event':    eventReceived(msg.taskId, msg.event); break
      case 'task:approval': showApproval(msg.taskId, msg.event); break
    }
  }, { signal: ac.signal })

  ws.addEventListener('close', () => {
    setTimeout(() => connect(url), 2000)  // auto-reconnect
  }, { signal: ac.signal })
}

export function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}
```

No `useEffect`. No `useRef`. No closure traps. The `ws` variable is module-scoped and always current.

### Event Stream Rendering (TaskDetail)

The event stream is append-only — the most natural pattern for vanilla DOM:

```js
// task-detail.js

const container = document.getElementById('event-stream')

export function appendEventToStream(event) {
  const el = renderEvent(event)
  container.appendChild(el)
  container.scrollTop = container.scrollHeight
}

function renderEvent(event) {
  switch (event.kind) {
    case 'text':
      const div = document.createElement('div')
      div.className = 'event-text'
      div.innerHTML = DOMPurify.sanitize(marked.parse(event.data.text))
      return div
    case 'tool_use':
      return renderToolCall(event.data.tool)
    case 'approval_req':
      return renderApprovalPrompt(event)
    case 'error':
      const err = document.createElement('div')
      err.className = 'event-error'
      err.textContent = event.data.message
      return err
  }
}
```

Each new event is O(1) — one `appendChild`. React would re-render the entire list or require virtualization. For a streaming log, vanilla DOM is both simpler and faster.

### Markdown Rendering

```html
<!-- index.html -->
<script type="module">
  import { marked } from 'https://cdn.jsdelivr.net/npm/marked@15/lib/marked.esm.js'
  import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.es.mjs'

  window.renderMarkdown = (text) => DOMPurify.sanitize(marked.parse(text))
</script>
```

Two dependencies, loaded from CDN, no install step. `DOMPurify` prevents XSS from `innerHTML`. This replaces `react-markdown` + `remark` + `rehype` (3 dependencies with plugin configuration).

---

## Task Lifecycle

```
User creates task          POST /api/tasks { title, cwd, type: "plan" }
                                    │
Scheduler picks it up               ▼
(no deps blocking)         Worker.run() → Claude SDK starts
                                    │
Claude streams output               ▼
                           WS: task:event (text, tool_use, ...)
                                    │
Claude finishes plan                ▼
                           status → "review", plan_result stored
                                    │
User reads plan in         plan-review.js renders markdown
PlanReview view                     │
                                    ▼
User confirms              POST /api/tasks/:id/confirm { title }
                                    │
Server creates new task    type: "task", depends_on: null (plan is done)
with plan as context                │
                                    ▼
Scheduler picks it up      Worker.run() → Claude executes
                                    │
Tool needs approval                 ▼
                           WS: task:approval { tool: "Bash", input: "rm -rf..." }
                                    │
User approves/denies       WS: { type: "approve", allow: false }
                                    │
Claude continues/stops              ▼
                           status → "done" or "failed"
```

---

## Design Decisions

| Decision | voice-doc approach | claudecodeui approach | This design |
|----------|-------------------|----------------------|-------------|
| Real-time | HTTP polling (1-5s) | WebSocket streaming | **WebSocket** — lower latency, less server load |
| Storage | JSON files | SQLite + .jsonl | **SQLite** — atomic, queryable, no corruption |
| SDK integration | External processes | `@anthropic-ai/claude-agent-sdk` | **SDK** — in-process, streamable, no parsing |
| Task model | File-based, flat | Session-based (no task concept) | **DB tasks + event log** — best of both |
| Concurrency | Git worktrees | Single session | **Worker pool** with configurable max |
| Tool approval | None (auto) | In-flight via WS | **Selective approval via WS** — safe tools auto-approved |
| Plan workflow | Two-phase (plan, review, execute) | None | **Kept** — valuable for complex tasks |
| Frontend | React (voice-doc DevPage) | React 18 + Vite | **Vanilla ES modules** — see evaluation above |
| Styling | Tailwind CSS | Tailwind CSS | **CSS custom properties** — no build step, no config |
| Markdown | react-markdown | react-markdown + rehype | **marked + DOMPurify** — two deps, CDN loaded |

---

## Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "better-sqlite3": "^11.0",
    "express": "^4.21",
    "ws": "^8.18",
    "ulid": "^2.3"
  }
}
```

5 server dependencies. Zero frontend build dependencies. `marked` and `DOMPurify` are loaded from CDN in the browser (or vendored into `public/vendor/` for offline use).

---

## Deliberately Omitted

These can be added later but are not part of the minimal core:

- **Auth** — start single-user, add when needed
- **Project discovery** — user provides `cwd` per task; no scanning `~/.claude/`
- **Shell/terminal** — Claude handles tool execution internally
- **File browser / git panel** — tasks produce diffs you review elsewhere
- **Voice input** — can bolt on later; not core to orchestration
- **i18n** — add when needed
- **Multiple providers** (Cursor, Codex) — Claude-only focus
- **TypeScript** — adds a build step; JSDoc type annotations provide IDE support without transpilation

---

## Estimated Size

- **Server**: ~600 lines across 4 files
- **Frontend**: ~700 lines across 10 files (smaller per-file, more files)
- **Total**: ~1300 lines of application code
