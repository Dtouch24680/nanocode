/**
 * Spec for the JSONL IPC framer (server/ipc/protocol.js).
 *
 * Public API expected:
 *   export function encodeFrame(obj) → Buffer  // utf-8 JSON + '\n'
 *   export function createFramer() → {
 *     feed(chunk: Buffer | string, onFrame: (frame) => void) → void
 *     reset() → void
 *   }
 *
 *   export const FRAMES = {
 *     REGISTER: 'register', REGISTER_OK: 'register:ok',
 *     CLAIM_REQUEST: 'claim:request', CLAIM_CODE: 'claim:code',
 *     CLAIM_INVALIDATE: 'claim:invalidate',
 *     HTTP: 'http', HTTP_RES: 'http:res', HTTP_CHUNK: 'http:chunk', HTTP_END: 'http:end',
 *     PING: 'ping', PONG: 'pong',
 *     SHUTDOWN: 'shutdown',
 *   }
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tryImport, skip } from './fixtures/test-helpers.js'

const mod = await tryImport(new URL('../../ipc/protocol.js', import.meta.url))

describe('IPC protocol', () => {
  it('encodeFrame produces newline-terminated UTF-8 JSON', (t) => {
    if (!mod) return skip(t, 'server/ipc/protocol.js not implemented yet')
    const buf = mod.encodeFrame({ type: 'ping', id: 1 })
    assert.ok(Buffer.isBuffer(buf))
    assert.equal(buf[buf.length - 1], 0x0A, 'ends in \\n')
    assert.deepEqual(JSON.parse(buf.subarray(0, buf.length - 1).toString('utf-8')),
      { type: 'ping', id: 1 })
  })

  it('framer emits one frame per complete line', (t) => {
    if (!mod) return skip(t, 'server/ipc/protocol.js not implemented yet')
    const f = mod.createFramer()
    const got = []
    f.feed('{"type":"ping","id":1}\n{"type":"pong","id":1}\n', (frame) => got.push(frame))
    assert.deepEqual(got, [
      { type: 'ping', id: 1 },
      { type: 'pong', id: 1 },
    ])
  })

  it('framer buffers across split chunks', (t) => {
    if (!mod) return skip(t, 'server/ipc/protocol.js not implemented yet')
    const f = mod.createFramer()
    const got = []
    f.feed('{"type":"pi', (frame) => got.push(frame))
    f.feed('ng","id":1}\n{"type":"pong"', (frame) => got.push(frame))
    assert.deepEqual(got, [{ type: 'ping', id: 1 }])
    f.feed(',"id":2}\n', (frame) => got.push(frame))
    assert.deepEqual(got, [
      { type: 'ping', id: 1 },
      { type: 'pong', id: 2 },
    ])
  })

  it('framer handles binary Buffer input', (t) => {
    if (!mod) return skip(t, 'server/ipc/protocol.js not implemented yet')
    const f = mod.createFramer()
    const got = []
    f.feed(Buffer.from('{"type":"ping"}\n', 'utf-8'), (frame) => got.push(frame))
    assert.deepEqual(got, [{ type: 'ping' }])
  })

  it('framer discards malformed JSON lines (does not throw)', (t) => {
    if (!mod) return skip(t, 'server/ipc/protocol.js not implemented yet')
    const f = mod.createFramer()
    const got = []
    f.feed('not json\n{"type":"ping"}\nalso not json\n', (frame) => got.push(frame))
    assert.deepEqual(got, [{ type: 'ping' }])
  })

  it('framer rejects frames over 4 MB (DOS guard)', (t) => {
    if (!mod) return skip(t, 'server/ipc/protocol.js not implemented yet')
    const f = mod.createFramer()
    const got = []
    const huge = 'x'.repeat(5 * 1024 * 1024) // 5 MB, no newline
    assert.throws(() => f.feed(huge, (frame) => got.push(frame)), /frame too large/i)
  })

  it('FRAMES enum covers every protocol message type', (t) => {
    if (!mod) return skip(t, 'server/ipc/protocol.js not implemented yet')
    const expected = [
      'REGISTER', 'REGISTER_OK',
      'CLAIM_REQUEST', 'CLAIM_CODE', 'CLAIM_INVALIDATE',
      'HTTP', 'HTTP_RES', 'HTTP_CHUNK', 'HTTP_END',
      'PING', 'PONG',
      'SHUTDOWN',
    ]
    for (const key of expected) {
      assert.ok(typeof mod.FRAMES[key] === 'string', `FRAMES.${key} defined`)
    }
  })

  it('reset() clears partial buffer', (t) => {
    if (!mod) return skip(t, 'server/ipc/protocol.js not implemented yet')
    const f = mod.createFramer()
    const got = []
    f.feed('{"type":"pi', (frame) => got.push(frame))
    f.reset()
    f.feed('{"type":"ng"}\n', (frame) => got.push(frame))
    assert.deepEqual(got, [{ type: 'ng' }], 'partial was discarded')
  })
})
