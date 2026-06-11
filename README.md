# Nanocode

A minimal terminal workspace for managing projects and AI coding assistants.

## Features

- Split-pane terminal with bash and AI assistant side by side
- Multi-project sidebar with per-project working directories
- SSH remote project support — connect to remote machines seamlessly
- Session management — create, resume, archive, and filter sessions
- Supports Claude Code, Cursor Agent, and OpenCode as CLI providers
- No build step — vanilla JS served as static files

## Install

```bash
git clone https://github.com/victoriacity/nanocode.git
cd nanocode
```

Then run the install script, which handles Node.js, build tools, and dependencies automatically:

**Linux / macOS / Git Bash:**

```bash
./install.sh
```

**Windows (PowerShell):**

```powershell
.\install.ps1
```

Open `http://localhost:3000`.

## Usage

- **Add a project** — click `+` in the sidebar, pick a local folder or toggle "Remote (SSH)" for a remote machine
- **Terminal** — left pane is bash, right pane is your AI assistant
- **Sessions** — create new sessions with `+`, switch between them with tabs
- **Settings** — choose your preferred CLI provider

## Production

```bash
npm run pm2:start
```

## Tests

```bash
npm test
```

---

## Architecture & Code Logic (for AI contributors)

This section documents internals so AI agents making code changes understand the system before editing it. **Read this before modifying any server, worker, or terminal file.**

### Layer Responsibilities

| Layer | Entry point | Responsibility |
|---|---|---|
| `server/index.js` | `node server/index.js` | Single-user HTTP+WS server. Hosts all Express routes, serves `public/`, owns the store singleton, proxies TTS, manages the agents config. In system mode this becomes the router; workers handle per-user sessions. |
| `server/store.js` | `getStore()` | Persistent JSON store for projects, tabs, settings. Single file: `data/nanocode.json`. Uses atomic tmp+rename writes. |
| `worker/index.js` | spawned by setuid helper | Per-user process in system/multi-user mode. Owns PTY sessions and per-user `~/.nanocode/data.json`. Connects to router via Unix socket. |
| `worker/data-store.js` | `DataStore` class | Atomic JSON store for worker (same shape as server/store, already uses tmp+rename). |
| `terminal/routes.js` | `createTerminalRoutes()` | Express router for all `/api/projects`, `/api/tabs`, PTY management. Shared by both server and worker. |
| `terminal/sessions.js` | `SessionStore` | In-memory PTY/session Map. Flushes scrollback to `~/.nanocode/scrollback/<tabId>` every 5 s using tmp+rename. |
| `terminal/claude-sdk-driver.js` | `ClaudeSDKDriver` | Drives `@anthropic-ai/claude-agent-sdk` for Claude Code sessions. Handles streaming, tool use, session resume. |
| `public/` | static files | Vanilla JS frontend — no build step. `app.js` is the main entry. |

### Session History — Three Storage Layers

Understanding these layers is critical for diagnosing "session disappeared" bugs:

| Layer | What is stored | Location | Crash behavior |
|---|---|---|---|
| Structural metadata | projects, tabs (IDs, labels, types, claudeSessionId) | `data/nanocode.json` (server) or `~/.nanocode/data.json` (worker) | Safe since atomic write: either old or new file survives |
| PTY scrollback | Terminal output buffer for display on reconnect | `~/.nanocode/scrollback/<tabId>` | Last ≤5 s of output may be lost (flush interval) |
| Runtime session Map | Active PTY/process handles, in-memory state | RAM only | Lost on crash. But `claudeSessionId` in the metadata layer persists, so `--continue` can resume the Claude conversation |

True "session loss" = metadata file corrupted on write. That is prevented by the atomic write in `save()` / `_write()`. Do not weaken these.

### Robustness Hard Rules (AI must not violate these)

1. **Every async Express route handler must have a try/catch (or use asyncWrap).**
   Express 4 does not catch rejected async handlers — they become `unhandledRejection` which kills the process in Node ≥ 15. Always wrap:
   ```js
   app.get('/api/foo', async (req, res) => {
     try {
       // ...
     } catch (err) {
       console.error('[/api/foo]', err)
       res.status(500).json({ error: err.message })
     }
   })
   ```

2. **Critical state writes must use tmp+rename atomic write.**
   Direct `writeFileSync(path, data)` can truncate the file if the process crashes mid-write. Always:
   ```js
   const tmp = filePath + '.tmp'
   writeFileSync(tmp, JSON.stringify(data, null, 2))
   renameSync(tmp, filePath)
   ```
   `server/store.js` `save()` and `worker/data-store.js` `_write()` both implement this. Do not change them to direct writes.

3. **Process-level uncaughtException/unhandledRejection handlers must log and keep alive.**
   Both `server/index.js` and `worker/index.js` install these handlers. They must never call `process.exit()`. If you add a new process entry point, replicate these handlers.

4. **Side-channel features (TTS, ntfy, auth status) must not crash the main process or lose data.**
   TTS failures are caught at three layers: outer try/catch in the handler, ttsSerialize queue safeFn wrapper, and the process-level unhandledRejection guard. Do not remove any of these layers.

5. **Corrupt JSON on load must be backed up, not silently erased.**
   `server/store.js` backs up to `.bak` before falling back to `emptyData()`. This preserves the broken file for forensic recovery. Do not change the catch block to silently return `emptyData()` without a backup.

### Deployment — DO NOT MODIFY

> AI contributors: this section describes the actual deployment. Do not change any of the files or behavior described here.

**Dev / single-user mode (this repo's typical usage):**
- `npm start` or `npm run dev` — runs `node server/index.js` directly.
- Port defaults to `3000` (override with `PORT=`).
- Data stored in `data/nanocode.json` relative to the repo.
- The working instance at port `3001` on `10.18.8.55` is the live server. Do not kill or restart it without explicit instruction.

**System / multi-user mode (`NANOCODE_SYSTEM=1`):**
- `scripts/install.sh` (requires root) copies the app to `/usr/lib/nanocode/`, creates a `nanocode` system user, installs a setuid helper (`helper/nanocode-spawn`), and installs a systemd unit.
- The router listens on TCP, each user spawned via `nanocode login` gets their own worker process with their own data file under `~/.nanocode/`.
- Auto-update timer (`nanocode-update.timer`) pulls from git daily.
- The CLI is `bin/nanocode` (login/logout/status subcommands).

**What "deployment logic" means and why not to touch it:**
`scripts/install.sh`, `scripts/nanocode.service`, `scripts/nanocode-update.sh`, `bin/nanocode`, `helper/`, `server/router-mode.js` — these files control how the system-wide service is installed and started. Modifications require root access and systemd restarts. Changes to port numbers, startup scripts, or process topology belong to the ops layer, not to feature development.
