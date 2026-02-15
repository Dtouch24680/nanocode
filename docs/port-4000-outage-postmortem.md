# Postmortem: Port 4000 Terminal Server Unavailable After Integration

**Date**: 2026-02-15
**Duration**: ~30 minutes (from integration completion to detection)
**Severity**: High — terminal UI on port 4000 completely unavailable

## Summary

During the Phase 1-3 integration of the codebuilder and terminal systems into a unified server on port 3000, the standalone terminal server on port 4000 was destroyed instead of being preserved for backward compatibility. Three destructive actions were taken:

1. `terminal/server.js` was deleted (`rm`)
2. `terminal/public/` directory was deleted (`rm -r`)
3. The `terminal` PM2 process entry was removed from `ecosystem.config.cjs`

## Root Cause

The implementation plan specified "Server Merge" but did not explicitly include a backward compatibility requirement for port 4000. The implementing agent interpreted "merge" as "replace" — consolidating everything into `server/index.js` on port 3000 and removing the standalone server entirely.

The three contributing factors:

1. **Ambiguous plan language**: The plan said "Delete `terminal/server.js` (replaced by routes.js)" and "Delete `terminal/public/` (merged into public/)". These were framed as cleanup steps, not as breaking changes.

2. **No backward-compat test**: The plan's success criteria for Phase 1 mentioned verifying port 3000 serves both UIs, but did not include "port 4000 still responds."

3. **Irreversible destructive actions**: `rm -r terminal/public` and `rm terminal/server.js` were executed without confirmation. These files were not committed to git, so they could not be trivially recovered.

## Impact

- Port 4000 returned `ERR_CONNECTION_REFUSED`
- Any bookmarks, scripts, or mobile shortcuts pointing to `:4000` stopped working
- The PM2 `terminal` process showed as `stopped` with no script to restart

## Resolution

1. **Created new `terminal/server.js`** — a thin wrapper (~70 lines) that imports `server/store.js` and `terminal/routes.js`, serves the unified `public/` frontend, and handles WebSocket at `/ws/terminal`. This is much smaller than the original because all logic lives in the shared modules.

2. **Restored `terminal` entry in `ecosystem.config.cjs`** — both `codebuilder` (port 3000) and `terminal` (port 4000) now run as separate PM2 processes.

3. **Both servers share the same SQLite database** via `getStore()` singleton per process. SQLite WAL mode handles concurrent access safely.

The old `terminal/public/` was NOT restored — instead, port 4000 now serves the same unified UI from `public/`. This is acceptable because the unified UI is a superset of the old terminal-only UI (it has the Terminal tab plus the Tasks tab).

## Lessons Learned

1. **Integration plans must explicitly state backward compatibility requirements.** "Merge A and B" does not mean "delete A." The plan should have said: "Port 4000 must remain available. Create a thin wrapper that reuses the shared modules."

2. **Destructive file operations (`rm -r`) should be the last step, not the first.** The old files should have been kept until the new server was verified end-to-end, including backward compat on the old port.

3. **Plan success criteria must include negative tests.** "Port 4000 still responds" is as important as "Port 3000 serves both UIs."

4. **The refactor-to-shared-module pattern (routes.js) was the right call.** It made the backward-compat fix trivial — the new `terminal/server.js` is just 70 lines because all logic is in `routes.js`.

## Current State

| Port | Process | Serves |
|------|---------|--------|
| 3000 | `codebuilder` | Unified app (tasks + terminal + sidebar) |
| 4000 | `terminal` | Same unified app (backward compat entry point) |

Both processes share:
- `terminal/routes.js` — project/session/slack REST routes + WebSocket handler
- `server/store.js` — SQLite database (projects, tasks, events)
- `public/` — unified frontend with sidebar, tab bar, kanban board, terminal panes
