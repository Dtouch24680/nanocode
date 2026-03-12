# Codebuilder — Project Design

How the reduced terminal-first app stays small, explicit, and easy for agents to modify.

---

## Project Structure

```
codebuilder/
├── AGENTS.md
├── docs/
│   ├── architecture.md
│   └── design.md
├── server/
│   ├── index.js          # Unified app server
│   ├── store.js          # SQLite for projects, settings, session metadata
│   └── tests/
│       └── store.test.js
├── public/
│   ├── index.html
│   ├── style.css
│   ├── js/
│   │   ├── app.js
│   │   ├── state.js
│   │   ├── api.js
│   │   ├── sidebar.js
│   │   ├── tab-bar.js
│   │   ├── settings.js
│   │   ├── terminal-view.js
│   │   ├── terminal-pane.js
│   │   ├── split-pane.js
│   │   └── local-echo.js
│   └── docs/
│       └── state-management.md
├── terminal/
│   ├── routes.js
│   ├── sessions.js
│   ├── server.js
│   └── tests/
│       └── e2e.test.js
└── package.json
```

## Structural Decisions

**Terminal-first scope.** The app now focuses on project-scoped terminal sessions and a small settings surface. Keep new features aligned with that narrower shape.

**One mutable frontend state object.** `public/js/state.js` only tracks project selection, active tab, and CLI provider. Avoid introducing reducers, stores, or framework-style indirection.

**Shared terminal transport.** `terminal/routes.js` and `terminal/sessions.js` remain the source of truth for PTY-backed session behavior inside the main app.

**Prepared-statement data layer.** `server/store.js` stays small and synchronous. If new persistence is needed, add it there with explicit functions and tests.

## Documentation Requirements

Document non-trivial flows with mermaid diagrams in `docs/` or `public/docs/`, and keep module comments pointing back to the relevant section.

## Code Conventions

- Name by function, not location
- Delete dead code instead of leaving compatibility shims
- Prefer direct DOM updates over abstractions
- Split files only when responsibilities diverge clearly
- Keep the frontend buildless: static files + ES modules only

## Testing Strategy

- `server/tests/store.test.js` covers project/settings/session metadata behavior
- `terminal/tests/e2e.test.js` covers REST + `/ws/terminal` session flow
- Run `npm run test` for fast store coverage and `npm run test:terminal-e2e` when changing transport behavior

## Dependency on architecture.md

`docs/architecture.md` describes what the app does. This document describes how the code stays organized. Update both when the shape of the app changes.
