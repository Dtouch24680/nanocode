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

The script works whether run from inside the repo or from a parent directory. It detects existing installs and updates them.

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
