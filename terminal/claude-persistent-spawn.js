/**
 * claude-persistent-spawn.js
 *
 * Provides a `spawnClaudeCodeProcess` hook for the SDK driver that spawns the
 * claude binary as a **detached, session-leader process** so it survives
 * nanocode server restart/hot-deploy.
 *
 * ## Why sub-agents die on server restart
 *
 * Without this module the SDK's `spawnLocalProcess` is used, which:
 *   1. Spawns claude without `detached: true` (shares nanocode's process group).
 *   2. Registers the process in a global `md` Set via `W2(proc)`.
 *   3. On `process.on('exit')` the SDK's V2 handler SIGTERMs every entry in `md`.
 *
 * When nanocode is killed (hot-deploy or crash), V2 fires → claude is SIGTERMed
 * → all sub-agent child processes of claude die too.
 *
 * ## Fix strategy (Option B — detached + kill-guard)
 *
 * We return a proxy `SpawnedProcess` object that:
 *   - Wraps a real child_process spawned with `detached: true` + own stdio.
 *   - Intercepts `kill(signal)` calls: SIGTERM that comes from V2 (i.e., during
 *     nanocode's own exit) is silently ignored; SIGTERM/SIGKILL from the SDK's
 *     AbortSignal handler (legitimate user interrupt or teardown) is forwarded.
 *   - Uses `proc.unref()` so the claude process doesn't keep nanocode alive.
 *
 * The detached+setsid ensures that when the nanocode Node process dies via
 * SIGKILL (or its event loop simply exits after V2's no-op), the claude binary
 * remains alive in its own session, allowing in-flight sub-agents to complete.
 *
 * ## Re-attach on restart
 *
 * Nanocode's streaming session uses `resume: claudeSessionId`, so after a
 * server restart the new streaming session resumes the same claude context.
 * The old claude process will eventually be orphaned and exit when its stdin
 * pipe (now closed by nanocode's death) gives it an EOF — the fix doesn't
 * try to recycle the OS process, it only ensures sub-agents get a chance to
 * run to completion during the window between nanocode's exit and the EOF
 * reaching claude.
 *
 * For truly long-lived background tasks (overnight agents), a full relay-socket
 * approach would be needed.
 */

import { spawn as defaultSpawn } from 'node:child_process'

// ── Nanocode-exit guard ───────────────────────────────────────────────────────
// Set to true when the nanocode process is preparing to exit. While this flag
// is true, SIGTERM calls from the SDK's V2 exit handler are no-ops (we don't
// want to kill the claude process during our own shutdown).
let _nanocodeExiting = false

process.once('exit', () => { _nanocodeExiting = true })

// We do NOT add SIGTERM/SIGINT listeners here.
// Reason: adding any listener to SIGTERM/SIGINT overrides Node.js's default
// terminate-on-signal behaviour, which would prevent nanocode from exiting.
// Instead we rely solely on process.on('exit') to set the flag.
//
// The 'exit' handler fires before the SDK's V2 handler (both are on 'exit')
// because our module is imported (and thus registers its 'exit' handler) before
// the SDK ever calls W2() — which is only done when the first streaming session
// starts.  Registration order of 'exit' handlers is FIFO, so ours fires first:
//   1. Our handler  → _nanocodeExiting = true
//   2. SDK V2       → proxy.kill('SIGTERM') → guarded → no-op
//
// This ensures the guard is in place before V2 tries to kill the claude process.

/**
 * Creates a `spawnClaudeCodeProcess` function suitable for passing to the SDK
 * `query()` options.  Returns a SpawnedProcess-compatible proxy object that
 * wraps a real `child_process.spawn` result with the kill-guard applied.
 *
 * @param {object} [opts]
 * @param {string} [opts.logPrefix] - Prefix for console.log messages.
 * @param {Function} [opts.spawnImpl] - child_process.spawn replacement for tests.
 * @param {Function} [opts.isNanocodeExiting] - exit-state override for tests.
 * @param {number} [opts.killEscalationMs] - SIGKILL delay after AbortSignal SIGTERM.
 * @returns {(spawnOpts: object) => object} SpawnedProcess factory.
 */
export function createPersistentSpawnHook({
  logPrefix = '[persistent-spawn]',
  spawnImpl = defaultSpawn,
  isNanocodeExiting = () => _nanocodeExiting,
  killEscalationMs = 5000,
} = {}) {
  return function spawnClaudeCodeProcess({ command, args = [], cwd, env, signal }) {
    // Spawn with detached: true so the child gets its own process group / session.
    // This prevents SIGKILL to nanocode's process group from reaching claude.
    const child = spawnImpl(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: true,     // child gets own process group; survives parent exit
      // Do NOT pass `signal` here — we manage the abort lifecycle ourselves
      // via the proxy's kill() to avoid race conditions between the abort
      // signal and the V2 exit-handler.
    })

    // Detach from the event loop: the claude process should outlive nanocode.
    child.unref?.()

    console.log(`${logPrefix} spawned detached claude PID=${child.pid} (${command} ${args.slice(0, 3).join(' ')}...)`)

    // ── Kill guard ────────────────────────────────────────────────────────────
    // Legitimate termination can come from the SDK close/abort path (for
    // example force reset). The SDK V2 process-exit handler also calls
    // kill('SIGTERM') on every tracked process. We block only the latter.
    //
    // Distinguishing strategy: track whether the AbortSignal has been aborted.
    // If we receive kill('SIGTERM') while nanocode is exiting AND the signal
    // hasn't been aborted, this is V2 → ignore.
    // Otherwise: forward the signal.

    let _terminationRequested = false
    let _abortRequested = signal?.aborted === true

    const forwardKill = (sig) => {
      if (child.exitCode !== null) return false
      if (sig === 'SIGTERM' || sig === 'SIGKILL') {
        _terminationRequested = true
      }
      try { return child.kill(sig) } catch { return false }
    }

    // Listen to the AbortSignal so we can forward the kill when the SDK
    // legitimately wants to terminate the process (outside of nanocode exit).
    if (signal) {
      const onAbort = () => {
        _abortRequested = true
        if (_terminationRequested || child.exitCode !== null) return
        // AbortSignal fired — this is a legitimate SDK-driven close.
        // Forward SIGTERM, then SIGKILL after the graceful window.
        console.log(`${logPrefix} AbortSignal fired for PID=${child.pid}, sending SIGTERM`)
        forwardKill('SIGTERM')
        const timer = setTimeout(() => {
          try {
            if (child.exitCode === null) forwardKill('SIGKILL')
          } catch {}
        }, killEscalationMs)
        timer.unref?.()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      child.once?.('exit', () => {
        signal.removeEventListener?.('abort', onAbort)
      })
    }

    // Build the SpawnedProcess proxy.
    const proxy = {
      stdin: child.stdin,
      stdout: child.stdout,

      get killed() { return child.killed || _terminationRequested },
      get exitCode() { return child.exitCode },

      kill(sig = 'SIGTERM') {
        // V2 fires on process.on('exit') and sends SIGTERM to all tracked
        // processes. Since W2() adds our proxy to md, V2 calls
        // proxy.kill('SIGTERM'). Ignore only that shutdown SIGTERM; if the
        // SDK's forwarded AbortSignal has fired, this is a legitimate close.
        if (sig === 'SIGTERM' && isNanocodeExiting() && !_abortRequested) {
          console.log(`${logPrefix} ignoring SIGTERM for PID=${child.pid} (nanocode exiting — preserving background sub-agents)`)
          return false
        }
        console.log(`${logPrefix} forwarding ${sig} to PID=${child.pid}`)
        return forwardKill(sig)
      },

      on(event, listener) {
        child.on(event, listener)
        return this
      },
      once(event, listener) {
        child.once(event, listener)
        return this
      },
      off(event, listener) {
        child.off(event, listener)
        return this
      },
    }

    return proxy
  }
}
