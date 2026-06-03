/** Persistent PTY sessions with scrollback. Sessions survive client disconnect. */

import pty from 'node-pty'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

const OUTPUT_FLUSH_MS = 12
const SCROLLBACK_SIZE = 100 * 1024 // 100KB
const SCROLLBACK_FLUSH_MS = 5000

/**
 * Circular buffer for raw terminal output; replay on reconnect.
 * Optionally persisted to disk so the visual state survives a worker
 * restart (e.g., after a host reboot). The PTY itself is gone, but
 * scrollback replay shows the last view the user had — including any
 * full-screen TUIs like Claude Code, which redraw correctly when their
 * alt-screen ANSI sequences are replayed.
 */
class ScrollbackBuffer {
  constructor({ maxSize = SCROLLBACK_SIZE, path = null } = {}) {
    this._maxSize = maxSize
    this._path = path
    this._data = ''
    this._dirty = false
    this._flushTimer = null
    if (path && existsSync(path)) {
      try {
        this._data = readFileSync(path, 'utf-8')
        if (this._data.length > this._maxSize) {
          this._data = this._data.slice(-this._maxSize)
        }
      } catch { /* corrupt → start empty */ }
      if (this._data.length > 0) {
        // The prior process may have left us in alt-screen mode (e.g.,
        // Claude Code's TUI). Append a sequence that exits alt-screen
        // and resets attributes, plus a human-readable marker. xterm.js
        // will replay this and end up back on the normal screen before
        // the fresh PTY's first byte arrives.
        this._data +=
          '\x1b[?1049l\x1b[m\r\n\r\n' +
          '\x1b[90m── worker restarted — previous output above is from before ──\x1b[m\r\n\r\n'
        if (this._data.length > this._maxSize) {
          this._data = this._data.slice(-this._maxSize)
        }
      }
    }
  }

  append(data) {
    this._data += data
    if (this._data.length > this._maxSize) {
      this._data = this._data.slice(-this._maxSize)
    }
    if (this._path) {
      this._dirty = true
      if (!this._flushTimer) {
        this._flushTimer = setTimeout(() => this.flush(), SCROLLBACK_FLUSH_MS)
      }
    }
  }

  getContents() {
    return this._data
  }

  flush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    if (!this._path || !this._dirty) return
    try {
      const dir = dirname(this._path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
      const tmp = this._path + '.tmp'
      writeFileSync(tmp, this._data, { mode: 0o600 })
      renameSync(tmp, this._path)
      this._dirty = false
    } catch { /* best-effort */ }
  }

  clear() {
    this._data = ''
    if (this._path && this._dirty) {
      this._dirty = false
    }
    this.flush()
  }
}

/** Single persistent session: one PTY + scrollback + set of attached clients */
class Session {
  /**
   * @param {string} _key
   * @param {string} command
   * @param {string[]} args
   * @param {number} cols
   * @param {number} rows
   * @param {string} cwd
   * @param {string} [scrollbackPath] — if provided, scrollback persists here
   */
  constructor(_key, command, args, cols, rows, cwd, scrollbackPath) {
    this._key = _key
    this._command = command
    this._args = args
    this._cwd = cwd
    this._scrollback = new ScrollbackBuffer({ path: scrollbackPath })
    /** @type {Set<import('ws').WebSocket>} */
    this._clients = new Set()
    this._exited = false
    this._exitCode = null
    this._proc = null
    this._outBuf = ''
    this._flushTimer = null
    this._spawn(cols, rows)
  }

  _spawn(cols, rows) {
    // Validate cwd exists — node-pty throws "File not found" on Windows if it doesn't
    let cwd = this._cwd
    if (!cwd || !existsSync(cwd)) {
      console.warn(`[pty] cwd does not exist: ${cwd}, falling back to home`)
      cwd = homedir()
    }
    // Validate command exists
    let command = this._command
    if (!existsSync(command)) {
      console.warn(`[pty] command not found: ${command}`)
    }
    console.log(`[pty] spawn: command=${command} args=${JSON.stringify(this._args)} cwd=${cwd}`)
    // Strip session-identity vars that Claude Code sets in the parent process so
    // that any `claude` invocations started inside this PTY (e.g. codex/agent/
    // claude tab types or a user typing `claude` in a bash tab) get a clean
    // environment and cannot accidentally re-use the main session's UUID.
    // See the same strip logic in routes.js → buildClaudeChildEnv().
    const STRIP_PTY_KEYS = new Set([
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_EXECPATH',
      'CLAUDE_CODE_TMPDIR',
      'AI_AGENT',
    ])
    const ptyEnv = { TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '3' }
    for (const [k, v] of Object.entries(process.env)) {
      if (!STRIP_PTY_KEYS.has(k)) ptyEnv[k] = v
    }

    this._proc = pty.spawn(command, this._args, {
      name: 'xterm-256color',
      cols: Math.max(1, cols || 80),
      rows: Math.max(1, rows || 24),
      cwd,
      env: ptyEnv,
    })

    this._proc.onData((data) => {
      this._scrollback.append(data)
      this._outBuf += data
      if (!this._flushTimer) {
        this._flushTimer = setTimeout(() => this._flush(), OUTPUT_FLUSH_MS)
      }
    })

    this._proc.onExit(({ exitCode, signal }) => {
      this._flush()
      this._exited = true
      this._exitCode = exitCode
      const msg = JSON.stringify({ type: 'exit', exitCode, signal })
      for (const ws of this._clients) {
        if (ws.readyState === 1) ws.send(msg)
      }
    })
  }

  _flush() {
    this._flushTimer = null
    if (!this._outBuf) return
    const data = this._outBuf
    this._outBuf = ''
    const msg = JSON.stringify({ type: 'output', data })
    for (const ws of this._clients) {
      if (ws.readyState === 1) ws.send(msg)
    }
  }

  /**
   * @param {import('ws').WebSocket} ws
   * @param {number} cols
   * @param {number} rows
   */
  attach(ws, cols, rows) {
    const history = this._scrollback.getContents()
    if (history) {
      ws.send(JSON.stringify({ type: 'history', data: history }))
    }
    this._clients.add(ws)
    if (this._proc && !this._exited) {
      try {
        this._proc.resize(Math.max(1, cols), Math.max(1, rows))
      } catch {
        // ignore
      }
    }

    const onMessage = (raw) => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      switch (msg.type) {
        case 'input':
          if (this._proc) this._proc.write(msg.data)
          break
        case 'resize':
          if (this._proc && !this._exited) {
            const c = Math.max(1, msg.cols || 80)
            const r = Math.max(1, msg.rows || 24)
            try {
              this._proc.resize(c, r)
            } catch {
              // ignore
            }
          }
          break
        case 'ping':
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong', id: msg.id }))
          break
        case 'restart':
          if (this._exited) this.restart(msg.cols || 80, msg.rows || 24)
          break
      }
    }

    ws.on('message', onMessage)
    ws.on('close', () => {
      ws.removeListener('message', onMessage)
      this.detach(ws)
    })
  }

  /**
   * @param {import('ws').WebSocket} ws
   */
  detach(ws) {
    this._clients.delete(ws)
  }

  /**
   * @param {number} cols
   * @param {number} rows
   */
  restart(cols, rows) {
    if (this._proc) {
      try {
        this._proc.kill()
      } catch {
        // already dead
      }
      this._proc = null
    }
    this._scrollback.clear()
    this._exited = false
    this._exitCode = null
    this._spawn(cols, rows)
  }

  destroy() {
    if (this._flushTimer) clearTimeout(this._flushTimer)
    this._scrollback.flush()
    if (this._proc) {
      try {
        this._proc.kill()
      } catch {
        // ignore
      }
    }
    this._clients.clear()
  }
}

/** @type {Map<string, Session>} */
const sessions = new Map()

/**
 * @param {string} sessionKey — e.g. projectId:bash
 * @param {string} command
 * @param {string[]} args
 * @param {number} cols
 * @param {number} rows
 * @param {string} cwd
 * @returns {Session}
 */
export function getOrCreate(sessionKey, command, args, cols, rows, cwd, scrollbackPath) {
  let session = sessions.get(sessionKey)
  if (!session) {
    session = new Session(sessionKey, command, args, cols, rows, cwd, scrollbackPath)
    sessions.set(sessionKey, session)
  }
  return session
}

/**
 * @param {string} sessionKey
 * @returns {Session | null}
 */
export function get(sessionKey) {
  return sessions.get(sessionKey) ?? null
}

/**
 * List active bash tab IDs for a project. Session keys are shaped
 * `${projectId}:bash:${tabId}`.
 * @param {string} projectId
 * @returns {string[]} array of tab ID strings
 */
export function listProjectSessions(projectId) {
  const prefix = `${projectId}:bash:`
  const ids = []
  for (const key of sessions.keys()) {
    if (key.startsWith(prefix)) ids.push(key.slice(prefix.length))
  }
  return ids
}

/**
 * Destroy a single session by key.
 * @param {string} sessionKey
 * @returns {boolean} true if the session existed and was destroyed
 */
export function destroySession(sessionKey) {
  const session = sessions.get(sessionKey)
  if (session) {
    session.destroy()
    sessions.delete(sessionKey)
    return true
  }
  return false
}

/**
 * Destroy all bash sessions for a project.
 * @param {string} projectId
 */
export function destroySessions(projectId) {
  const prefix = `${projectId}:bash:`
  const legacyKey = `${projectId}:bash`
  const toDelete = []
  for (const key of sessions.keys()) {
    if (key === legacyKey || key.startsWith(prefix)) toDelete.push(key)
  }
  for (const key of toDelete) {
    const session = sessions.get(key)
    if (session) {
      session.destroy()
      sessions.delete(key)
    }
  }
}
