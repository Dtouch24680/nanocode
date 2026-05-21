/**
 * JSONL IPC framer for the router ↔ worker channel.
 *
 * Frames are UTF-8 JSON objects, one per line, terminated by '\n'.
 * The framer is intentionally minimal so the privileged side of the
 * pipe is easy to audit.
 */

const MAX_FRAME_BYTES = 4 * 1024 * 1024 // 4 MB

export const FRAMES = Object.freeze({
  REGISTER: 'register',
  REGISTER_OK: 'register:ok',
  CLAIM_REQUEST: 'claim:request',
  CLAIM_CODE: 'claim:code',
  CLAIM_INVALIDATE: 'claim:invalidate',
  HTTP: 'http',
  HTTP_RES: 'http:res',
  HTTP_CHUNK: 'http:chunk',
  HTTP_END: 'http:end',
  PING: 'ping',
  PONG: 'pong',
  SHUTDOWN: 'shutdown',
})

/** Encode a JS object as a single newline-terminated UTF-8 frame. */
export function encodeFrame(obj) {
  return Buffer.from(JSON.stringify(obj) + '\n', 'utf-8')
}

/**
 * Stateful framer. Feed chunks of bytes/strings; receive parsed objects
 * via the callback. Malformed JSON lines are dropped silently
 * (operationally we want a misbehaving peer to be ignored, not crash
 * the router).
 */
export function createFramer() {
  let buf = ''

  return {
    feed(chunk, onFrame) {
      const str = typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString('utf-8')
          : String(chunk)
      buf += str
      // 4 MB DoS guard — if the buffer grows without ever seeing '\n',
      // we're looking at either a malicious peer or a runaway payload.
      if (buf.length > MAX_FRAME_BYTES && !buf.includes('\n')) {
        const size = buf.length
        buf = ''
        throw new Error(`frame too large: ${size} bytes without a delimiter`)
      }
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line) continue
        try {
          const obj = JSON.parse(line)
          onFrame(obj)
        } catch {
          // Malformed line — skip, keep going.
        }
      }
    },
    reset() {
      buf = ''
    },
  }
}
