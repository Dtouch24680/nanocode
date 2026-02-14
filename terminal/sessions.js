/**
 * Persistent PTY sessions with scrollback. Sessions survive client disconnect.
 */

import pty from 'node-pty'

const OUTPUT_FLUSH_MS = 12
const SCROLLBACK_SIZE = 100 * 1024 // 100KB

/** Circular buffer for raw terminal output; replay on reconnect */
class ScrollbackBuffer {
  constructor(maxSize = SCROLLBACK_SIZE) {
    this._maxSize = maxSize
    this._data = ''
  }

  append(data) {
    this._data += data
    if (this._data.length > this._maxSize) {
      this._data = this._data.slice(-this._maxSize)
    }
  }

  getContents() {
    return this._data
  }

  clear() {
    this._data = ''
  }
}

/** Single persistent session: one PTY + scrollback + set of attached clients */
class Session {
  /**
   * @param {string} _key — session key (projectId:sessionType)
   * @param {string} command
   * @param {string[]} args
   * @param {number} cols
   * @param {number} rows
   * @param {string} cwd
   */
  constructor(_key, command, args, cols, rows, cwd) {
    this._key = _key
    this._command = command
    this._args = args
    this._cwd = cwd
    this._scrollback = new ScrollbackBuffer()
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
    this._proc = pty.spawn(this._command, this._args, {
      name: 'xterm-256color',
      cols: Math.max(1, cols || 80),
      rows: Math.max(1, rows || 24),
      cwd: this._cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        FORCE_COLOR: '3', // override inherited FORCE_COLOR=0 — PTY supports full 24-bit color
      },
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
export function getOrCreate(sessionKey, command, args, cols, rows, cwd) {
  let session = sessions.get(sessionKey)
  if (!session) {
    session = new Session(sessionKey, command, args, cols, rows, cwd)
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
 * List active claude session IDs for a project.
 * Scans the sessions Map for keys matching `projectId:claude:*`.
 * @param {string} projectId
 * @returns {string[]} array of session ID strings (claude session IDs or new-N keys)
 */
export function listClaudeSessions(projectId) {
  const prefix = `${projectId}:claude:`
  const ids = []
  for (const key of sessions.keys()) {
    if (key.startsWith(prefix)) {
      ids.push(key.slice(prefix.length))
    }
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
 * Destroy all sessions for a project (bash + all claude sessions).
 * @param {string} projectId
 */
export function destroySessions(projectId) {
  const toDelete = []
  for (const key of sessions.keys()) {
    if (key === `${projectId}:bash` || key.startsWith(`${projectId}:claude:`)) {
      toDelete.push(key)
    }
  }
  for (const key of toDelete) {
    const session = sessions.get(key)
    if (session) {
      session.destroy()
      sessions.delete(key)
    }
  }
}
