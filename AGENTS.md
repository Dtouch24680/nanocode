# Agent Development Guide

## Quick Reference

- `npm run dev` — start server with auto-restart (serves API + static files on :3000)
- `npm run test` — run store tests
- `npm run test:terminal-e2e` — run terminal transport integration tests
- `npm run check` — lint + test

## Project Structure

```
nanocode/
├── AGENTS.md
├── docs/
│   ├── architecture.md
│   └── design.md
├── server/
│   ├── index.js
│   ├── store.js
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

## Reference Patterns

Study these files before modifying related areas:

- `server/store.js` — prepared statements, tiny sync data layer
- `terminal/routes.js` — project/session REST and `/ws/terminal` attach flow
- `public/js/terminal-view.js` — terminal session UI and provider switching
- `public/js/state.js` — minimal shared mutable state

## Documentation Requirements

All non-trivial interactions should have a data-flow doc with a mermaid diagram.
Every module and exported function should include an `Architecture:` backlink.
See `docs/design.md` for conventions.

## Design Principles

- Name by function, not location
- No lazy deprecation — delete dead code
- Keep the app terminal-first and small
- Split files only when they exceed ~400 lines or truly have two responsibilities
- No build step — frontend is vanilla ES modules served as static files
- Mutable state, explicit renders — no framework magic between intent and DOM
