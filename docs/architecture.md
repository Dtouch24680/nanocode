# Nanocode Architecture

Minimal terminal workspace — project sidebar, split terminal (bash + AI assistant), SSH remote support.

## Stack

- **Server:** Express + WebSocket (ws) + node-pty
- **Storage:** JSON file (`data/nanocode.json`)
- **Frontend:** Vanilla JS + xterm.js, no build step

## Files

```
server/index.js       Express app, static files, WS upgrade
server/store.js       JSON file persistence
terminal/routes.js    REST API + WS attach handler + SSH config
terminal/sessions.js  PTY session manager with scrollback
public/js/app.js      Entry point, routing, tabs, settings
public/js/sidebar.js  Project list UI
public/js/landing.js  Host/project picker overlay
public/js/terminal-view.js   Session management, split pane orchestration
public/js/terminal-pane.js   xterm + WebSocket + PTY bridge
public/js/api.js      REST helpers
public/js/state.js    Shared mutable state
public/js/router.js   URL slug utilities
public/js/local-echo.js  Client-side input prediction
```

## WebSocket Protocol

`/ws/terminal` — per-pane transport between xterm.js and server PTY.

1. Client sends `{type: "attach", projectId, sessionType, cols, rows, cliProvider}`
2. Server spawns or resumes PTY session, sends scrollback history
3. Client sends `{type: "input", data}`, server relays to PTY
4. Server sends `{type: "output", data}` from PTY to client
5. Client sends `{type: "resize", cols, rows}` on terminal resize
