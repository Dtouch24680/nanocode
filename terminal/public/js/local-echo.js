/**
 * LocalEcho — client-side prediction for remote terminal echo.
 * Displays typed characters immediately and reconciles with server output
 * to suppress duplicates. Reduces perceived latency on high-RTT connections.
 */

const PREDICTION_TIMEOUT_MS = 1000

/** Single printable character is codepoint >= 32 and not ESC */
function isPrintable(data) {
  if (data.length === 0) return false
  if (data.includes('\x1b')) return false
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i)
    if (c < 32) return false
  }
  return true
}

export class LocalEcho {
  /**
   * @param {{ write: (s: string) => void }} term — object with write() to display in terminal
   */
  constructor(term) {
    this._term = term
    /** @type {Array<{ char: string, ts: number }>} */
    this._queue = []
    this.enabled = false // set true by TerminalPane when RTT > threshold
  }

  /**
   * Call on user input. If we predict echo, return the string to display locally; else null.
   * @param {string} data — raw input from xterm.onData
   * @returns {string | null} — string to write to terminal immediately, or null
   */
  predict(data) {
    if (!this.enabled) return null

    // Backspace: undo last prediction if any
    if (data === '\x7f' || data === '\b') {
      if (this._queue.length > 0) {
        this._queue.pop()
        return '\b \b'
      }
      return null
    }

    // Control / special: clear predictions and do not echo locally
    if (!isPrintable(data)) {
      this._clearPredictions()
      return null
    }

    const now = Date.now()
    for (let i = 0; i < data.length; i++) {
      const c = data[i]
      if (c.charCodeAt(0) < 32) {
        this._clearPredictions()
        return null
      }
      this._queue.push({ char: c, ts: now })
    }
    return data
  }

  /**
   * Call when server output arrives. Consumes matching predictions and returns
   * the remaining output that should be displayed.
   * @param {string} serverOutput — raw output from server
   * @returns {string} — output to write to terminal (may be empty)
   */
  reconcile(serverOutput) {
    this._expireOldPredictions()

    // Conservative: any ESC in server output → clear predictions and show all
    if (serverOutput.includes('\x1b')) {
      this._clearPredictions()
      return serverOutput
    }

    let outIdx = 0
    const outLen = serverOutput.length

    while (outIdx < outLen && this._queue.length > 0) {
      const pred = this._queue[0]
      const serverChar = serverOutput[outIdx]
      if (pred.char === serverChar) {
        this._queue.shift()
        outIdx++
      } else {
        this._clearPredictions()
        return serverOutput.slice(outIdx)
      }
    }

    return serverOutput.slice(outIdx)
  }

  _expireOldPredictions() {
    const cutoff = Date.now() - PREDICTION_TIMEOUT_MS
    while (this._queue.length > 0 && this._queue[0].ts < cutoff) {
      this._queue.shift()
    }
  }

  _clearPredictions() {
    if (this._queue.length === 0) return
    const backspaceErase = '\b \b'
    for (let i = 0; i < this._queue.length; i++) {
      this._term.write(backspaceErase)
    }
    this._queue.length = 0
  }
}
