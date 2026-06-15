import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createPersistentSpawnHook } from '../../terminal/claude-persistent-spawn.js'

function createSpawnFixture() {
  const child = new EventEmitter()
  child.pid = 4242
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.killed = false
  child.exitCode = null
  child.killCalls = []
  child.unrefCalled = false
  child.kill = (signal = 'SIGTERM') => {
    child.killCalls.push(signal)
    child.killed = true
    return true
  }
  child.unref = () => {
    child.unrefCalled = true
  }

  const spawnCalls = []
  const spawnImpl = (command, args, options) => {
    spawnCalls.push({ command, args, options })
    return child
  }

  return { child, spawnCalls, spawnImpl }
}

describe('claude persistent spawn hook', () => {
  it('spawns claude detached and does not pass AbortSignal into child_process.spawn', () => {
    const { child, spawnCalls, spawnImpl } = createSpawnFixture()
    const controller = new AbortController()
    const hook = createPersistentSpawnHook({ logPrefix: '[test]', spawnImpl })

    const proc = hook({
      command: 'node',
      args: ['fake-claude.js', '--output-format', 'stream-json'],
      cwd: '/tmp/workspace',
      env: { PATH: '/bin' },
      signal: controller.signal,
    })

    assert.equal(spawnCalls.length, 1)
    assert.equal(spawnCalls[0].command, 'node')
    assert.deepEqual(spawnCalls[0].args, ['fake-claude.js', '--output-format', 'stream-json'])
    assert.equal(spawnCalls[0].options.cwd, '/tmp/workspace')
    assert.equal(spawnCalls[0].options.env.PATH, '/bin')
    assert.equal(spawnCalls[0].options.detached, true)
    assert.deepEqual(spawnCalls[0].options.stdio, ['pipe', 'pipe', 'ignore'])
    assert.equal(Object.hasOwn(spawnCalls[0].options, 'signal'), false)
    assert.equal(child.unrefCalled, true)
    assert.equal(proc.stdin, child.stdin)
    assert.equal(proc.stdout, child.stdout)
  })

  it('ignores SDK exit-handler SIGTERM while nanocode is exiting', () => {
    const { child, spawnImpl } = createSpawnFixture()
    const hook = createPersistentSpawnHook({
      logPrefix: '[test]',
      spawnImpl,
      isNanocodeExiting: () => true,
    })
    const proc = hook({ command: 'node', args: ['fake-claude.js'] })

    assert.equal(proc.kill('SIGTERM'), false)
    assert.deepEqual(child.killCalls, [])
    assert.equal(proc.killed, false)
  })

  it('forwards normal SIGTERM and still allows SIGKILL escalation', () => {
    const { child, spawnImpl } = createSpawnFixture()
    const hook = createPersistentSpawnHook({
      logPrefix: '[test]',
      spawnImpl,
      isNanocodeExiting: () => false,
    })
    const proc = hook({ command: 'node', args: ['fake-claude.js'] })

    assert.equal(proc.kill('SIGTERM'), true)
    assert.equal(proc.killed, true)
    assert.equal(proc.kill('SIGKILL'), true)
    assert.deepEqual(child.killCalls, ['SIGTERM', 'SIGKILL'])
  })

  it('treats AbortSignal termination as legitimate even during nanocode exit', () => {
    const { child, spawnImpl } = createSpawnFixture()
    const controller = new AbortController()
    const hook = createPersistentSpawnHook({
      logPrefix: '[test]',
      spawnImpl,
      isNanocodeExiting: () => true,
      killEscalationMs: 60_000,
    })
    const proc = hook({
      command: 'node',
      args: ['fake-claude.js'],
      signal: controller.signal,
    })

    assert.equal(proc.kill('SIGTERM'), false)
    controller.abort()

    assert.deepEqual(child.killCalls, ['SIGTERM'])
    assert.equal(proc.killed, true)
  })
})
