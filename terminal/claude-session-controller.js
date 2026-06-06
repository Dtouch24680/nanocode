import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { platform } from 'node:os'
import { join } from 'node:path'
import * as sessions from './sessions.js'

export function createClaudeSessionController({ store, home, recentAgents }) {
  const IS_WIN = platform() === 'win32'
  const SHELL = IS_WIN
    ? (process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe')
    : 'bash'
  const SSH = IS_WIN ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh'

  // Map: sessionKey -> { claudeSessionId, clients, history, busy }
  const claudeSessions = new Map()

  const TAB_LAUNCHERS = {
    bash: () => 'exec bash -l',
    claude: () => {
      const autoResume = store.getSetting('claude_autoresume')
      const enabled = autoResume !== '0'
      if (!enabled) {
        return 'claude --dangerously-skip-permissions; exec bash -l'
      }
      return [
        'set +H;',
        '_cbr_first=1;',
        '_cbr_continue() {',
        '  while true; do',
        '    if [ "$_cbr_first" = "1" ]; then',
        '      _cbr_first=0;',
        '      claude --dangerously-skip-permissions;',
        '    else',
        '      _cbr_start=$SECONDS;',
        '      claude --continue --dangerously-skip-permissions;',
        '      _cbr_elapsed=$(( SECONDS - _cbr_start ));',
        '      if [ "$_cbr_elapsed" -lt 2 ]; then',
        '        echo "[nanocode] claude --continue failed quickly (no session?), dropping to bash";',
        '        break;',
        '      fi;',
        '    fi;',
        '    echo "";',
        '    echo "[nanocode] Claude exited. Press any key within 3s to stay in bash, or wait to auto-resume...";',
        '    _cbr_key="";',
        '    read -r -s -n 1 -t 3 _cbr_key;',
        '    if [ -n "$_cbr_key" ]; then',
        '      echo "[nanocode] Dropping to bash (key pressed).";',
        '      break;',
        '    fi;',
        '    echo "[nanocode] Auto-resuming...";',
        '  done;',
        '};',
        '_cbr_continue;',
        'exec bash -l',
      ].join(' ')
    },
    codex: () => 'codex --dangerously-bypass-approvals-and-sandbox; exec bash -l',
    agent: () => 'agent --force --approve-mcps; exec bash -l',
    opencode: () => 'opencode .; exec bash -l',
  }

  function sessionKeyFor(projectId, tabId) {
    return `${projectId}:claude:${tabId}`
  }

  function setClaudeSessionId(projectId, tabId, claudeSessionId, { resetTurnCount = false } = {}) {
    const cs = claudeSessions.get(sessionKeyFor(projectId, tabId))
    if (!cs) return
    cs.claudeSessionId = claudeSessionId
    if (resetTurnCount) cs.turnCount = 0
  }

  /** Build SSH args for a remote project. */
  function buildSshArgs(project, remoteCmd) {
    const args = [
      '-tt',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-p', String(project.ssh_port || 22),
    ]
    if (project.ssh_key) args.push('-i', project.ssh_key)
    args.push(`${project.ssh_user || 'root'}@${project.ssh_host}`)
    args.push(`bash -lc ${sq(remoteCmd)}`)
    return args
  }

  /** Shell-escape a string for use inside single quotes. */
  function sq(s) {
    return "'" + s.replace(/'/g, "'\\''") + "'"
  }

  function claudeBroadcast(cs, event) {
    cs.history.push(event)
    if (cs.history.length > 500) cs.history.shift()
    const msg = JSON.stringify({ type: 'claude-event', event })
    for (const client of cs.clients) {
      if (client.readyState === 1) try { client.send(msg) } catch {}
    }
  }

  let _lastGcMs = 0
  function gcClaudeSessions() {
    const now = Date.now()
    if (now - _lastGcMs < 60_000) return
    _lastGcMs = now
    try {
      const sessDir = join(home, '.claude', 'sessions')
      if (!existsSync(sessDir)) return
      const files = readdirSync(sessDir)
      for (const f of files) {
        if (!/^\d+\.json$/.test(f)) continue
        const pid = parseInt(f, 10)
        try {
          process.kill(pid, 0)
        } catch {
          try {
            unlinkSync(join(sessDir, f))
            console.log(`[gc:sessions] removed stale lock for PID ${pid}`)
          } catch {}
        }
      }
    } catch {}
  }

  function buildClaudeChildEnv() {
    const STRIP_KEYS = new Set([
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_EXECPATH',
      'CLAUDE_CODE_TMPDIR',
      'AI_AGENT',
    ])
    const env = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (!STRIP_KEYS.has(k)) env[k] = v
    }
    return env
  }

  function runClaudeTurn(cs, userText, sessionKey, cwd) {
    if (cs.busy) {
      if (!Array.isArray(cs.queue)) cs.queue = []
      cs.queue.push(userText)
      const queuedEvent = {
        type: 'system', subtype: 'queued',
        text: `Message queued (position ${cs.queue.length}). Will run after current turn.`,
      }
      claudeBroadcast(cs, queuedEvent)
      return
    }
    cs.busy = true
    cs.currentProc = null

    const isFirstTurn = cs.turnCount === 0
    if (isFirstTurn) gcClaudeSessions()
    const sessionArg = isFirstTurn
      ? `--session-id=${cs.claudeSessionId}`
      : `--resume=${cs.claudeSessionId}`
    cs.turnCount++

    const claudeModel = store.getSetting('claude_model') || ''
    const claudeEffort = store.getSetting('claude_effort') || ''
    const permMode = store.getSetting('claude_permission_mode') || 'bypass'
    const tabLabel = cs.tabLabel || ''

    const launchArgs = [
      '--print',
      '--output-format=stream-json',
      '--verbose',
      '--include-partial-messages',
    ]

    if (permMode === 'bypass') {
      launchArgs.push('--dangerously-skip-permissions')
    } else if (permMode === 'accept-edits') {
      launchArgs.push('--permission-mode', 'acceptEdits')
    } else if (permMode === 'auto') {
      launchArgs.push('--permission-mode', 'auto')
    }

    if (claudeModel) launchArgs.push('--model', claudeModel)
    if (claudeEffort) launchArgs.push('--effort', claudeEffort)
    if (tabLabel) launchArgs.push('--name', tabLabel)

    launchArgs.push(sessionArg)
    launchArgs.push('--')
    launchArgs.push(userText)
    const escapedArgs = launchArgs.map((a) => sq(a))
    const launchCmd = `exec claude ${escapedArgs.join(' ')}`

    console.log(`[claude:spawn] sessionKey=${sessionKey} turn=${cs.turnCount} len=${userText.length}`)
    const proc = spawn('bash', ['-lc', launchCmd], {
      cwd,
      env: buildClaudeChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    proc._nanocodeInterrupted = false
    cs.currentProc = proc

    let lineBuffer = ''
    let _sessionConflict = false

    proc.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString('utf8')
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop()
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let event
        try { event = JSON.parse(trimmed) } catch { continue }
        claudeBroadcast(cs, event)
      }
    })

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim()
      if (!text) return
      if (!_sessionConflict && text.includes('is already in use')) {
        _sessionConflict = true
        console.warn(`[claude:session-conflict] ${sessionKey}: session still locked, will retry`)
        return
      }
      console.warn(`[claude:stderr] ${sessionKey}: ${text.slice(0, 120)}`)
      const event = { type: 'system', subtype: 'stderr', text }
      claudeBroadcast(cs, event)
    })

    proc.on('exit', (code, signal) => {
      cs.busy = false
      cs.currentProc = null

      if (_sessionConflict) {
        const attempt = (cs._conflictRetries || 0) + 1
        if (attempt <= 2) {
          cs._conflictRetries = attempt
          cs.turnCount--
          console.warn(`[claude:session-conflict] ${sessionKey}: retry #${attempt} in 1s`)
          setTimeout(() => {
            runClaudeTurn(cs, userText, sessionKey, cwd)
          }, 1000)
          return
        }
        cs._conflictRetries = 0
        const newSessionId = randomUUID()
        console.warn(`[claude:session-conflict] ${sessionKey}: exhausted retries, abandoning locked session ${cs.claudeSessionId} -> new ${newSessionId}`)
        cs.claudeSessionId = newSessionId
        cs.turnCount = 0
        if (store.updateTabMetadata) {
          const [projectId, , tabId] = sessionKey.split(':')
          store.updateTabMetadata(projectId, tabId, { claudeSessionId: newSessionId })
        }
      }

      const wasInterrupted = signal === 'SIGINT' || proc._nanocodeInterrupted === true
      const doneEvent = { type: 'result', subtype: wasInterrupted ? 'interrupted' : 'success' }
      claudeBroadcast(cs, doneEvent)
      if (code !== 0 && code != null && !wasInterrupted) {
        const event = { type: 'system', subtype: 'stderr', text: `claude exited with code ${code}` }
        claudeBroadcast(cs, event)
      }

      if (!Array.isArray(cs.queue)) cs.queue = []
      if (wasInterrupted) {
        if (cs.queue.length > 0) {
          const discarded = cs.queue.length
          cs.queue = []
          const ev = { type: 'system', subtype: 'info', text: `Queue cleared (${discarded} pending message${discarded > 1 ? 's' : ''} discarded after interrupt).` }
          claudeBroadcast(cs, ev)
        }
      } else if (cs.queue.length > 0) {
        const allQueued = cs.queue.splice(0)
        const combinedText = allQueued.join('\n\n')
        console.log(`[claude:queue] sessionKey=${sessionKey} flushing ${allQueued.length} queued message(s) as one turn`)
        setImmediate(() => runClaudeTurn(cs, combinedText, sessionKey, cwd))
      }
    })

    proc.on('error', (err) => {
      cs.busy = false
      cs.currentProc = null
      const doneEvent = { type: 'result', subtype: 'error' }
      claudeBroadcast(cs, doneEvent)
      const event = { type: 'system', subtype: 'spawn_error', text: err.message }
      claudeBroadcast(cs, event)
      if (cs.queue.length > 0) {
        const allQueued = cs.queue.splice(0)
        const combinedText = allQueued.join('\n\n')
        console.log(`[claude:queue] sessionKey=${sessionKey} flushing ${allQueued.length} queued message(s) after spawn error`)
        setImmediate(() => runClaudeTurn(cs, combinedText, sessionKey, cwd))
      }
    })
  }

  function attachClaudeSession(ws, { projectId, tabId, project }) {
    const sessionKey = sessionKeyFor(projectId, tabId)
    let cs = claudeSessions.get(sessionKey)

    if (!cs) {
      const tab = store.getTab ? store.getTab(projectId, tabId) : null
      let claudeSessionId = tab?.claudeSessionId || randomUUID()

      const mainSessionId = process.env.CLAUDE_CODE_SESSION_ID
      if (mainSessionId && claudeSessionId === mainSessionId) {
        console.warn(
          `[claude:session] Tab ${tabId} stored claudeSessionId collides with the running ` +
          `main session (${mainSessionId}). Generating a fresh UUID to avoid conflict.`
        )
        claudeSessionId = randomUUID()
        if (store.updateTabMetadata) {
          store.updateTabMetadata(projectId, tabId, { claudeSessionId })
        }
      }

      cs = {
        claudeSessionId,
        clients: new Set(),
        history: [],
        busy: false,
        turnCount: 0,
        cwd: project.cwd,
        currentProc: null,
        tabLabel: tab?.label || '',
        queue: [],
      }
      claudeSessions.set(sessionKey, cs)
    }

    for (const event of cs.history) {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'claude-event', event })) } catch {}
      }
    }

    cs.clients.add(ws)

    const onMsg = (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.type === 'claude-input' && typeof msg.text === 'string' && msg.text.trim()) {
        // ── /resume interception ─────────────────────────────────────────────
        // claude --print (non-interactive) blocks /resume with "isn't available
        // in this environment". Intercept here and route to nanocode's own
        // session-resume mechanism instead.
        if (msg.text.trim() === '/resume') {
          // Find the most-recent session for this project from cache (or any session
          // different from the current one if the cache has data).
          const cache = recentAgents.getCachedEntries()
          // Prefer entries matching the current project cwd, fall back to global most-recent
          const projectEntries = cache.filter(e => e.cwd === project.cwd)
          const candidates = projectEntries.length ? projectEntries : cache
          // Skip the session already loaded in this tab so we go "back" to the previous one
          const entry = candidates.find(e => e.sessionId !== cs.claudeSessionId) || candidates[0]
          if (entry && entry.sessionId) {
            // Tell the client to trigger the resume flow (same as clicking in Recent Agents)
            const resumeEvent = {
              type: 'system',
              subtype: 'resume-trigger',
              projectId,
              sessionId: entry.sessionId,
              projectName: entry.projectName || '',
              cwd: entry.cwd || project.cwd,
            }
            try { ws.send(JSON.stringify({ type: 'claude-event', event: resumeEvent })) } catch {}
          } else {
            // No previous session found — show an info message
            const infoEvent = {
              type: 'system',
              subtype: 'info',
              text: 'No previous session found. Start a new conversation to create one.',
            }
            try { ws.send(JSON.stringify({ type: 'claude-event', event: infoEvent })) } catch {}
          }
          return
        }
        const userEvent = {
          type: 'user',
          uuid: randomUUID(),
          message: { role: 'user', content: [{ type: 'text', text: msg.text }] },
          _nonce: msg._nonce || null,
        }
        claudeBroadcast(cs, userEvent)
        runClaudeTurn(cs, msg.text, sessionKey, project.cwd)
      } else if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong', id: msg.id })) } catch {}
      }
    }

    ws.on('message', onMsg)
    ws.on('close', () => {
      ws.removeListener('message', onMsg)
      cs.clients.delete(ws)
    })
  }

  function handleInterrupt(req, res) {
    const sessionKey = sessionKeyFor(req.params.id, req.params.tabId)
    const cs = claudeSessions.get(sessionKey)
    if (!cs) return res.status(404).json({ error: 'no claude session' })
    if (!cs.busy || !cs.currentProc) return res.json({ ok: false, reason: 'not busy' })
    const force = req.query.force === '1' || req.body?.force === true
    try {
      cs.currentProc._nanocodeInterrupted = true
      if (force) {
        cs.currentProc.kill('SIGKILL')
      } else {
        cs.currentProc.kill('SIGINT')
      }
      res.json({ ok: true, force: !!force })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  }

  function handleReset(req, res) {
    const sessionKey = sessionKeyFor(req.params.id, req.params.tabId)
    const cs = claudeSessions.get(sessionKey)
    if (!cs) return res.status(404).json({ error: 'no claude session' })

    if (cs.currentProc) {
      try { cs.currentProc.kill('SIGKILL') } catch {}
      cs.currentProc = null
    }

    const discarded = (cs.queue || []).length
    cs.busy = false
    cs.queue = []
    cs._conflictRetries = 0

    const oldSessionId = cs.claudeSessionId
    const newSessionId = randomUUID()
    cs.claudeSessionId = newSessionId
    cs.turnCount = 0
    if (store.updateTabMetadata) {
      store.updateTabMetadata(req.params.id, req.params.tabId, { claudeSessionId: newSessionId })
    }

    const doneEvent = { type: 'result', subtype: 'success' }
    claudeBroadcast(cs, doneEvent)
    const infoEvent = {
      type: 'system', subtype: 'info',
      text: `Session reset. ${discarded} queued message${discarded !== 1 ? 's' : ''} discarded. New session started.`,
    }
    claudeBroadcast(cs, infoEvent)

    console.log(`[claude:reset] ${sessionKey}: busy cleared, ${discarded} queued msgs discarded, session ${oldSessionId} -> ${newSessionId}`)
    res.json({ ok: true, discarded, oldSessionId, newSessionId })
  }

  function handleTerminalWs(ws) {
    const once = (raw) => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (msg.type !== 'attach') return

      const { projectId, sessionType, cols, rows } = msg
      const tabId = msg.tabId || randomUUID().slice(0, 8)
      if (!projectId || sessionType !== 'bash') return

      const project = store.getProject(projectId)
      if (!project) {
        ws.send(JSON.stringify({ type: 'error', error: 'project not found' }))
        return
      }

      const tab = store.getTab ? store.getTab(projectId, tabId) : null
      const tabType = tab?.type || 'bash'
      console.log(`[ws:attach] projectId=${projectId} tabId=${tabId} tabType=${tabType}`)

      if (tabType === 'claude') {
        const renderMode = store.getSetting('renderMode') || 'block'
        if (renderMode === 'terminal') {
          console.log(`[ws:attach] routing claude to PTY raw (renderMode=terminal)`)
        } else {
          console.log(`[ws:attach] routing to claude stream-json bridge`)
          attachClaudeSession(ws, { projectId, tabId, project })
          return
        }
      }

      const launcherFn = TAB_LAUNCHERS[tabType] || TAB_LAUNCHERS.bash
      const launchCmd = launcherFn()

      const sessionKey = `${projectId}:bash:${tabId}`
      const isRemote = !!project.ssh_host
      let command
      let args
      let cwd

      if (isRemote) {
        command = SSH
        args = buildSshArgs(project, `cd ${sq(project.cwd)} && ${launchCmd}`)
        cwd = home
      } else if (tabType === 'bash') {
        command = SHELL
        args = IS_WIN ? [] : ['--login']
        cwd = project.cwd
      } else {
        command = 'bash'
        args = ['-lc', launchCmd]
        cwd = project.cwd
      }

      const scrollbackDir = process.env.NANOCODE_SCROLLBACK_DIR
        || (process.env.HOME ? `${process.env.HOME}/.nanocode/scrollback` : null)
      const scrollbackPath = scrollbackDir
        ? `${scrollbackDir}/${projectId}__${tabId}.bin`
        : undefined

      const session = sessions.getOrCreate(
        sessionKey,
        command,
        args,
        Math.max(1, cols || 80),
        Math.max(1, rows || 24),
        cwd,
        scrollbackPath
      )
      if (tabType === 'codex') {
        session.enableCodexAutoSkip()
      }
      session.attach(ws, Math.max(1, cols || 80), Math.max(1, rows || 24))
    }

    ws.once('message', once)
  }

  return {
    claudeSessions,
    handleInterrupt,
    handleReset,
    handleTerminalWs,
    setClaudeSessionId,
  }
}
