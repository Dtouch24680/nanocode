const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  probeIntervalSec: 5,
  idleThresholdSec: 20,
  backgroundWaitThresholdSec: 240,
  approvalPatterns: [
    'Press enter to confirm or esc to cancel',
    'Yes, proceed',
  ],
  rateLimitedPatterns: [
    'rate\\s*limit',
    'usage\\s*limit',
  ],
  crashedPatterns: [
    '\\bKilled\\b',
    '\\bTraceback\\b',
    'Conversation interrupted',
  ],
})

const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/g
const SGR_RE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g
const SHELL_PROMPT_RE = /^(?:\[[^\]]+\]\s+)?[^\s@]+@[^\s:]+:[^\s$#]+[$#]\s*$|^[#$]\s*$/

function asBoolean(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false
  return fallback
}

function asPositiveInt(value, fallback, min = 1) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
}

function parsePatternSetting(value, fallback) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value !== 'string' || !value.trim()) return fallback
  const trimmed = value.trim()
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
    } catch {}
  }
  return trimmed
    .split(/\r?\n|,/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function compilePatterns(list) {
  return list
    .map((source) => {
      try { return new RegExp(source, 'i') } catch { return null }
    })
    .filter(Boolean)
}

function stripAnsi(text) {
  if (!text) return ''
  return String(text).replace(SGR_RE, '').replace(ANSI_RE, '')
}

function normalizeLine(text, maxLen = 240) {
  const compact = stripAnsi(text).replace(/\r/g, '\n')
  const lines = compact.split('\n').map((line) => line.trim()).filter(Boolean)
  const last = lines.length ? lines[lines.length - 1].replace(/\s+/g, ' ') : ''
  return last.length > maxLen ? `${last.slice(0, maxLen - 1)}...` : last
}

function appendTail(existing, text, maxLen = 4000) {
  const next = `${existing || ''}\n${stripAnsi(text || '')}`.trim()
  return next.length > maxLen ? next.slice(-maxLen) : next
}

function parseBackgroundWaitSeconds(text) {
  if (!text || !/Waiting for background terminal/i.test(text)) return null
  const minSecMatch = text.match(/Waiting for background terminal.*?(\d+)\s*m(?:in(?:ute)?s?)?\s*(\d+)?\s*s?/i)
  if (minSecMatch) {
    const mins = Number.parseInt(minSecMatch[1], 10) || 0
    const secs = Number.parseInt(minSecMatch[2] || '0', 10) || 0
    return mins * 60 + secs
  }
  const secOnlyMatch = text.match(/Waiting for background terminal.*?(\d+)\s*s(?:ec(?:ond)?s?)?/i)
  if (secOnlyMatch) return Number.parseInt(secOnlyMatch[1], 10) || 0
  return null
}

function extractClaudeText(event) {
  if (!event || typeof event !== 'object') return ''
  if (typeof event.text === 'string') return event.text
  if (event.type === 'rate_limit_event') return 'rate limit event'
  if (typeof event.result === 'string') return event.result
  const content = event.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

function extractCodexText(event) {
  if (!event || typeof event !== 'object') return ''
  if (typeof event.message === 'string') return event.message
  if (typeof event.item?.text === 'string') return event.item.text
  if (typeof event.item?.aggregated_output === 'string') return event.item.aggregated_output
  if (typeof event.error?.message === 'string') return event.error.message
  return ''
}

function toIso(ts) {
  return new Date(ts).toISOString()
}

export function createAgentHealthMonitor({
  store,
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  autoStart = true,
} = {}) {
  const entries = new Map()
  let notifier = null
  let timer = null

  function getConfig() {
    return {
      enabled: asBoolean(store?.getSetting?.('agent_health_enabled'), DEFAULT_CONFIG.enabled),
      probeIntervalSec: asPositiveInt(store?.getSetting?.('agent_health_probe_interval_sec'), DEFAULT_CONFIG.probeIntervalSec),
      idleThresholdSec: asPositiveInt(store?.getSetting?.('agent_health_idle_threshold_sec'), DEFAULT_CONFIG.idleThresholdSec),
      backgroundWaitThresholdSec: asPositiveInt(
        store?.getSetting?.('agent_health_background_wait_threshold_sec'),
        DEFAULT_CONFIG.backgroundWaitThresholdSec
      ),
      approvalPatterns: compilePatterns(parsePatternSetting(
        store?.getSetting?.('agent_health_patterns_approval'),
        DEFAULT_CONFIG.approvalPatterns
      )),
      rateLimitedPatterns: compilePatterns(parsePatternSetting(
        store?.getSetting?.('agent_health_patterns_rate_limited'),
        DEFAULT_CONFIG.rateLimitedPatterns
      )),
      crashedPatterns: compilePatterns(parsePatternSetting(
        store?.getSetting?.('agent_health_patterns_crashed'),
        DEFAULT_CONFIG.crashedPatterns
      )),
    }
  }

  function ensureEntry(meta) {
    const sessionKey = meta?.sessionKey
    if (!sessionKey) throw new Error('sessionKey required')
    let entry = entries.get(sessionKey)
    if (!entry) {
      entry = {
        sessionKey,
        projectId: meta.projectId || null,
        tabId: meta.tabId || null,
        tabType: meta.tabType || null,
        provider: meta.provider || null,
        source: meta.source || null,
        sessionId: meta.sessionId || null,
        threadId: meta.threadId || null,
        running: false,
        startedAt: null,
        startedAtMs: 0,
        lastActivityAt: 0,
        lastLine: '',
        tailText: '',
        state: 'active',
        reason: 'registered',
        lastEmittedState: null,
        lastEmittedReason: null,
        lastEmittedAt: 0,
      }
      entries.set(sessionKey, entry)
    }
    entry.projectId = meta.projectId || entry.projectId
    entry.tabId = meta.tabId || entry.tabId
    entry.tabType = meta.tabType || entry.tabType
    entry.provider = meta.provider || entry.provider
    entry.source = meta.source || entry.source
    entry.sessionId = meta.sessionId || entry.sessionId
    entry.threadId = meta.threadId || entry.threadId
    return entry
  }

  function buildPayload(entry, status) {
    return {
      type: 'agent_health',
      version: 1,
      agent_id: entry.threadId || entry.sessionId || entry.sessionKey,
      session_key: entry.sessionKey,
      session_id: entry.sessionId || null,
      thread_id: entry.threadId || null,
      project_id: entry.projectId || null,
      tab_id: entry.tabId || null,
      tab_type: entry.tabType || null,
      provider: entry.provider || null,
      source: entry.source || null,
      state: status.state,
      reason: status.reason,
      idle_seconds: status.idleSeconds,
      last_line: entry.lastLine || '',
      ts: toIso(now()),
      started_at: entry.startedAt || null,
      last_activity_at: entry.lastActivityAt ? toIso(entry.lastActivityAt) : null,
      wait_seconds: status.waitSeconds ?? null,
    }
  }

  function emit(entry, status, { force = false } = {}) {
    if (!force && entry.lastEmittedState === status.state && entry.lastEmittedReason === status.reason) return null
    entry.lastEmittedState = status.state
    entry.lastEmittedReason = status.reason
    entry.lastEmittedAt = now()
    const payload = buildPayload(entry, status)
    try { notifier?.(payload) } catch {}
    return payload
  }

  function matchAny(patterns, text) {
    return patterns.some((pattern) => pattern.test(text))
  }

  function classify(entry, config = getConfig()) {
    const idleSeconds = entry.lastActivityAt
      ? Math.max(0, Math.floor((now() - entry.lastActivityAt) / 1000))
      : 0
    const tail = entry.tailText || ''
    const backgroundWaitSeconds = parseBackgroundWaitSeconds(tail) ?? parseBackgroundWaitSeconds(entry.lastLine)
    const seesBackgroundWait = /Waiting for background terminal/i.test(tail) || /Waiting for background terminal/i.test(entry.lastLine)

    if (!entry.running) {
      return { state: 'stopped', reason: 'not_running', idleSeconds, waitSeconds: backgroundWaitSeconds }
    }
    if (matchAny(config.crashedPatterns, tail)) {
      return { state: 'crashed', reason: 'crash_pattern', idleSeconds, waitSeconds: backgroundWaitSeconds }
    }
    if (matchAny(config.rateLimitedPatterns, tail)) {
      return { state: 'rate_limited', reason: 'rate_limit_pattern', idleSeconds, waitSeconds: backgroundWaitSeconds }
    }
    if (matchAny(config.approvalPatterns, tail)) {
      return { state: 'approval_needed', reason: 'approval_prompt', idleSeconds, waitSeconds: backgroundWaitSeconds }
    }
    if (
      backgroundWaitSeconds != null &&
      backgroundWaitSeconds >= config.backgroundWaitThresholdSec
    ) {
      return { state: 'stuck', reason: 'background_terminal_wait', idleSeconds, waitSeconds: backgroundWaitSeconds }
    }
    if (seesBackgroundWait && idleSeconds >= config.backgroundWaitThresholdSec) {
      return { state: 'stuck', reason: 'background_terminal_wait', idleSeconds, waitSeconds: backgroundWaitSeconds }
    }
    if (idleSeconds >= config.idleThresholdSec) {
      return { state: 'idle', reason: 'idle_timeout', idleSeconds, waitSeconds: backgroundWaitSeconds }
    }
    return { state: 'active', reason: 'recent_output', idleSeconds, waitSeconds: backgroundWaitSeconds }
  }

  function evaluate(entry, { emitActiveRecovery = false, force = false } = {}) {
    const status = classify(entry)
    entry.state = status.state
    entry.reason = status.reason
    if (status.state === 'active') {
      if (emitActiveRecovery && entry.lastEmittedState && entry.lastEmittedState !== 'active') {
        return emit(entry, status, { force })
      }
      return null
    }
    return emit(entry, status, { force })
  }

  function registerSession(meta) {
    return ensureEntry(meta)
  }

  function startTracking(meta) {
    const entry = ensureEntry(meta)
    const ts = now()
    entry.running = true
    entry.startedAtMs = ts
    entry.startedAt = toIso(ts)
    entry.lastActivityAt = ts
    entry.state = 'active'
    entry.reason = 'turn_started'
    entry.lastLine = ''
    entry.tailText = ''
    return entry
  }

  function finishTracking(sessionKey, { state = 'completed', reason = 'completed' } = {}) {
    const entry = entries.get(sessionKey)
    if (!entry) return null
    entry.running = false
    entry.state = state
    entry.reason = reason
    const idleSeconds = entry.lastActivityAt
      ? Math.max(0, Math.floor((now() - entry.lastActivityAt) / 1000))
      : 0
    const payload = emit(entry, { state, reason, idleSeconds }, { force: true })
    entries.delete(sessionKey)
    return payload
  }

  function recordOutput(meta, text, { emitActiveRecovery = true } = {}) {
    if (!text) return null
    const entry = ensureEntry(meta)
    if (!entry.running) startTracking(meta)
    entry.lastActivityAt = now()
    entry.tailText = appendTail(entry.tailText, text)
    const lastLine = normalizeLine(text)
    if (lastLine) entry.lastLine = lastLine
    if (entry.source === 'pty' && SHELL_PROMPT_RE.test(entry.lastLine)) {
      return finishTracking(entry.sessionKey, { state: 'stopped', reason: 'shell_prompt' })
    }
    return evaluate(entry, { emitActiveRecovery })
  }

  function recordClaudeEvent(meta, event) {
    if (!event || typeof event !== 'object') return null
    const entry = ensureEntry(meta)
    if (event.session_id) entry.sessionId = event.session_id
    const text = extractClaudeText(event)
    const payload = text ? recordOutput(meta, text) : evaluate(entry, { emitActiveRecovery: true })
    if (event.type === 'rate_limit_event') {
      entry.tailText = appendTail(entry.tailText, 'rate limit event')
      return evaluate(entry, { emitActiveRecovery: true }) || payload
    }
    if (event.type === 'result' && !event.parent_tool_use_id) {
      return finishTracking(entry.sessionKey, {
        state: event.subtype === 'error_during_execution' ? 'stopped' : 'completed',
        reason: event.subtype || 'result',
      }) || payload
    }
    return payload
  }

  function recordCodexEvent(meta, event) {
    if (!event || typeof event !== 'object') return null
    const entry = ensureEntry(meta)
    if (event.thread_id) entry.threadId = event.thread_id
    const text = extractCodexText(event)
    const payload = text ? recordOutput(meta, text) : evaluate(entry, { emitActiveRecovery: true })
    if (event.type === 'turn.completed') {
      return finishTracking(entry.sessionKey, { state: 'completed', reason: 'turn_completed' }) || payload
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      return finishTracking(entry.sessionKey, { state: 'crashed', reason: event.type }) || payload
    }
    return payload
  }

  function scanNow() {
    const config = getConfig()
    if (!config.enabled) return []
    const emitted = []
    for (const entry of entries.values()) {
      if (!entry.running) continue
      const payload = evaluate(entry)
      if (payload) emitted.push(payload)
    }
    return emitted
  }

  function listSnapshot() {
    const config = getConfig()
    const agents = []
    for (const entry of entries.values()) {
      if (!entry.running) continue
      const status = classify(entry, config)
      entry.state = status.state
      entry.reason = status.reason
      agents.push(buildPayload(entry, status))
    }
    agents.sort((a, b) => String(a.session_key).localeCompare(String(b.session_key)))
    return {
      generated_at: toIso(now()),
      config: {
        enabled: config.enabled,
        probe_interval_sec: config.probeIntervalSec,
        idle_threshold_sec: config.idleThresholdSec,
        background_wait_threshold_sec: config.backgroundWaitThresholdSec,
      },
      agents,
    }
  }

  function destroySession(sessionKey) {
    entries.delete(sessionKey)
  }

  function setNotifier(fn) {
    notifier = typeof fn === 'function' ? fn : null
  }

  function start() {
    if (timer) return
    const tick = () => {
      try { scanNow() } catch {}
      const nextConfig = getConfig()
      const nextMs = Math.max(1000, nextConfig.probeIntervalSec * 1000)
      if (timer?.__nanocodeIntervalMs !== nextMs) {
        stop()
        timer = setIntervalImpl(tick, nextMs)
        if (timer) timer.__nanocodeIntervalMs = nextMs
      }
    }
    const intervalMs = Math.max(1000, getConfig().probeIntervalSec * 1000)
    timer = setIntervalImpl(tick, intervalMs)
    if (timer) timer.__nanocodeIntervalMs = intervalMs
  }

  function stop() {
    if (!timer) return
    clearIntervalImpl(timer)
    timer = null
  }

  if (autoStart) start()

  return {
    destroySession,
    finishTracking,
    getConfig,
    listSnapshot,
    recordClaudeEvent,
    recordCodexEvent,
    recordOutput,
    registerSession,
    scanNow,
    setNotifier,
    start,
    startTracking,
    stop,
  }
}
