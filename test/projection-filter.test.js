import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, WorkspaceStore } from '../index.js'

const session = { id: 'projection-fixture', header: {}, events: [] }
const relevantEvents = [
  { type: 'session/title', seq: 1, time: 1, data: { title: 'fixture title' } },
  { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '分析登录异常' }] } },
  { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '我来检查。' }] } } },
  { type: 'tool/call', seq: 4, time: 4, data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}' } },
  { type: 'tool/result', seq: 5, time: 5, data: { turn: 1, step: 1, message: { source: { callId: 'call-1' }, content: [{ type: 'text', text: 'done' }] } } },
  { type: 'todo/write', seq: 6, time: 6, data: { todos: [{ status: 'completed', content: '复现' }] } },
  { type: 'turn/end', seq: 7, time: 7, data: { reason: { kind: 'error', error: { message: '执行失败' } } } },
  { type: 'mcp/failure', seq: 8, time: 8, data: { message: 'custom failure' } },
]
const irrelevantEvents = [
  { type: 'llm/stream', seq: 101, time: 9, data: { delta: 'token' } },
  { type: 'llm/stream', seq: 102, time: 10, data: { delta: 'token' } },
  { type: 'usage/telemetry', seq: 103, time: 11, data: { tokens: 1 } },
]

function projectionHarness() {
  const listeners = new Map()
  let store
  let dirtyCount = 0
  let cloneCount = 0
  const clone = globalThis.structuredClone
  const proto = WorkspaceStore.prototype
  const originalLoad = proto.load
  const originalMarkDirty = proto.markDirty
  proto.load = async function () { store = this; this.state = { version: 4, hiddenSessionIds: [], workspaces: [] } }
  proto.markDirty = function () { dirtyCount += 1 }
  globalThis.structuredClone = (...args) => { cloneCount += 1; return clone(...args) }
  const directory = { cleanup: async () => {} }
  const ctx = {
    on: (name, handler) => listeners.set(name, handler),
    sessions: { list: () => [] },
    logger: { warn: error => { throw error } },
    effect: () => {},
    webServer: { register: () => {} },
  }
  return {
    listeners,
    directory,
    counts: () => ({ dirtyCount, cloneCount }),
    async cleanup() {
      proto.load = originalLoad
      proto.markDirty = originalMarkDirty
      globalThis.structuredClone = clone
      await directory.cleanup()
    },
    store: () => store,
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('background projection ignores events without a canvas representation', async () => {
  const harness = projectionHarness()
  try {
    apply(harnessCtx(harness), { dataFile: 'unused' })
    const onEvent = harness.listeners.get('session/event')
    for (const event of irrelevantEvents) { onEvent(session, event); await settle() }
    await harness.store().serial
    assert.equal(harness.counts().dirtyCount, 0)
    assert.equal(harness.counts().cloneCount, 0)
    assert.equal(harness.store().state.workspaces.length, 0)
  } finally {
    await harness.cleanup()
  }
})

test('background projection still applies relevant events without snapshot clones', async () => {
  const harness = projectionHarness()
  try {
    apply(harnessCtx(harness), { dataFile: 'unused' })
    const onEvent = harness.listeners.get('session/event')
    for (const event of relevantEvents) { onEvent(session, event); await settle() }
    await harness.store().serial
    const { dirtyCount, cloneCount } = harness.counts()
    assert.ok(dirtyCount >= 1, 'relevant events still mark the graph dirty')
    assert.equal(cloneCount, 0, 'background callers must not clone the thread')
    const thread = harness.store().state.workspaces[0].threads[0]
    assert.equal(thread.dshSessionTitle, 'fixture title')
    assert.ok(thread.messages.some(message => message.text.includes('分析登录异常')))
    assert.ok(thread.messages.some(message => message.kind === 'error'))
  } finally {
    await harness.cleanup()
  }
})

test('projected content is identical with and without background filtering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-filter-'))
  try {
    const replayed = { ...session, events: [...irrelevantEvents, ...relevantEvents] }
    const store = new WorkspaceStore(join(directory, 'state.json'))
    await store.projectSession(replayed, 0, 'DSH 任务', { snapshot: false })
    await store.flush()
    const projected = JSON.parse(JSON.stringify(store.state.workspaces[0].threads[0]))
    const reference = new WorkspaceStore(join(directory, 'reference.json'))
    for (const event of relevantEvents) await reference.projectEvent(replayed, event)
    await reference.flush()
    const expected = JSON.parse(JSON.stringify(reference.state.workspaces[0].threads[0]))
    // Replay and per-event projection order timestamps/ids differently; compare canvas-visible content.
    assert.deepEqual(
      projected.messages.map(message => `${message.kind}:${message.text}`),
      expected.messages.map(message => `${message.kind}:${message.text}`),
    )
    assert.equal(projected.dshSessionTitle, expected.dshSessionTitle)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('public projection methods keep returning isolated snapshots by default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-snapshot-'))
  try {
    const store = new WorkspaceStore(join(directory, 'state.json'))
    const snapshot = await store.projectEvents({ ...session, events: relevantEvents }, relevantEvents)
    assert.ok(Array.isArray(snapshot.messages), 'default call returns a thread snapshot')
    snapshot.title = 'mutated outside the store'
    assert.notEqual(store.state.workspaces[0].threads[0].title, snapshot.title)
    const withoutSnapshot = await store.projectEvents({ ...session, events: relevantEvents }, [relevantEvents[1]], 'DSH 任务', { snapshot: false })
    assert.equal(withoutSnapshot, null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function harnessCtx(harness) {
  return {
    on: (name, handler) => harness.listeners.set(name, handler),
    sessions: { list: () => [] },
    logger: { warn: error => { throw error } },
    effect: () => {},
    webServer: { register: () => {} },
  }
}
