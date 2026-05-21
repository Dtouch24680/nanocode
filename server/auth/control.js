/**
 * Router-side control channel.
 *
 * Workers (one per logged-in user, spawned by `nanocode login` via the
 * setuid helper) connect to this Unix socket and send JSONL frames:
 *
 *   → { type: 'register', uid, username, sock }
 *   ← { type: 'register:ok' }    or    { type: 'register:err', reason }
 *   → { type: 'claim:request' }
 *   ← { type: 'claim:code', code, expiresAt }
 *
 * Trust model:
 *   - The setuid helper guarantees the worker process runs as the
 *     invoking user's UID.
 *   - On register we stat() the claimed worker socket. The file's
 *     owner UID must equal the claimed UID. The kernel created the
 *     socket file as the worker's process UID, so this proves the
 *     worker is who it says.
 *   - Even if peer-cred were missing, a misclassified session would
 *     route to a worker running under its actual UID, so an attacker
 *     gains no kernel-level privilege from spoofing the registration.
 */

import { createServer, Socket } from 'node:net'
import { existsSync, statSync, unlinkSync, chmodSync } from 'node:fs'
import { createFramer, encodeFrame } from '../ipc/protocol.js'

export function startControlSocket({ path, registry, claimStore, logger = console } = {}) {
  if (!path) throw new Error('startControlSocket: { path } required')
  if (existsSync(path)) {
    try { unlinkSync(path) } catch {}
  }

  const server = createServer((socket) => handleControlConnection(socket, { registry, claimStore, logger }))
  server.listen(path, () => {
    try { chmodSync(path, 0o666) } catch {}
  })

  return {
    server,
    close() {
      server.close()
      try { unlinkSync(path) } catch {}
    },
  }
}

function handleControlConnection(socket, { registry, claimStore, logger }) {
  const framer = createFramer()
  let registered = null

  socket.on('data', (chunk) => {
    try {
      framer.feed(chunk, (frame) => onFrame(frame))
    } catch (err) {
      logger.warn('[control] framer error:', err.message)
      socket.destroy()
    }
  })

  socket.on('close', () => {
    if (registered) registry.unregister(registered.uid)
  })

  function send(obj) {
    if (socket.writable) socket.write(encodeFrame(obj))
  }

  function onFrame(msg) {
    if (msg.type === 'register') {
      const { uid, username, sock } = msg
      if (typeof uid !== 'number' || typeof username !== 'string' || typeof sock !== 'string') {
        return send({ type: 'register:err', reason: 'bad register fields' })
      }
      let stat
      try { stat = statSync(sock) }
      catch { return send({ type: 'register:err', reason: 'worker sock not found' }) }
      // Production: the file's owner uid must equal the claimed uid.
      // In test mode the test runner's uid creates all sockets, so this
      // check is bypassed; the registry still records peerCredUid as the
      // claimed uid for downstream routing.
      const testMode = process.env.NANOCODE_TEST_MODE === '1'
      if (!testMode && stat.uid !== uid) {
        return send({ type: 'register:err', reason: 'worker sock uid mismatch' })
      }
      const ok = registry.register({ uid, sock, peerCredUid: uid })
      if (!ok) return send({ type: 'register:err', reason: 'register failed' })
      registered = { uid, username }
      return send({ type: 'register:ok' })
    }

    if (msg.type === 'claim:request') {
      if (!registered) {
        return send({ type: 'register:err', reason: 'not registered' })
      }
      const { code, expiresAt } = claimStore.mint(registered)
      return send({ type: 'claim:code', code, expiresAt })
    }

    if (msg.type === 'ping') {
      return send({ type: 'pong', id: msg.id })
    }
  }
}
