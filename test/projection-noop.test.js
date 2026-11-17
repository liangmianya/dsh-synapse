import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, WorkspaceStore } from '../index.js'

const session = (id = 's1', events = []) => ({
  id, header: { cwd: 'C:\\projection' }, inheritedEventCount: 0,
  snapshotEvents: () => events,
})
const user = (seq, text = '问题') => ({ type: 'user/message', seq, time: seq + 1, data: { content: [{ type: 'text', text }] } })
const assistant = seq => ({ type: 'assistant/message', seq, time: seq + 1, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '回答' }] } } })
const call = seq => ({ type: 'tool/call', seq, time: seq + 1, data: { turn: 1, step: 1, callId: 'c1', name: 'shell' } })
const result = (seq, error) => ({ type: 'tool/result', seq, time: seq + 1, data: { turn: 1, step: 1, error, message: { source: { callId: 'c1' } } } })

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'synapse-projection-noop-'))
  const dataFile = join(directory, 'state.json')
  const store = new WorkspaceStore(dataFile)
  await store.ready
  t.after(async () => {
    clearTimeout(store.flushTimer)
    await store.serial
    await store.flush()
    return rm(directory, { recursive: true, force: true })
  })
  async function settle() {
    await store.flush()
    clearTimeout(store.flushTimer)
    store.flushTimer = null
  }
  return { store, dataFile, settle }
}

function observe(t, store) {
  const counts = { clones: 0, dirty: 0, saves: 0 }
  const clone = globalThis.structuredClone
  const markDirty = store.markDirty
  const save = store.save
  t.mock.method(globalThis, 'structuredClone', (...args) => { counts.clones += 1; return clone(...args) })
  t.mock.method(store, 'markDirty', function () { counts.dirty += 1; return markDirty.call(this) })
  t.mock.method(store, 'save', function () { counts.saves += 1; return save.call(this) })
  return counts
}

test('irrelevant event bursts never create a thread, clone it, or schedule a save', async t => {
  const { store, dataFile, settle } = await fixture(t)
  const before = await readFile(dataFile, 'utf8')
  const counts = observe(t, store)
  const events = Array.from({ length: 1_000 }, (_, seq) => ({ type: 'step/start', seq, time: seq + 1 }))
  events.push({ type: 'turn/end', seq: 1_001, time: 1_002, data: { reason: { kind: 'done' } } })
  assert.equal(await store.projectEvents(session(), events), null)
  await settle()
  assert.deepEqual(counts, { clones: 0, dirty: 0, saves: 0 })
  assert.deepEqual(await store.list(), [])
  assert.equal(await readFile(dataFile, 'utf8'), before)
})

test('injected and empty messages do not manufacture a new projection', async t => {
  const { store, settle } = await fixture(t)
  const counts = observe(t, store)
  const injected = user(1, '目录')
  injected.data.source = { kind: 'skill-catalog' }
  await store.projectEvents(session(), [
    injected,
    user(2, 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n环境'),
    user(3, '   '),
    { type: 'tool/result', seq: 4, time: 5, data: {} },
  ])
  await settle()
  assert.deepEqual(await store.list(), [])
  assert.deepEqual(counts, { clones: 0, dirty: 0, saves: 0 })
})

test('duplicate message sequence is rejected before reading its body', async t => {
  const { store, dataFile, settle } = await fixture(t)
  await store.projectSession(session('s1', [user(1)]))
  await settle()
  const before = await readFile(dataFile, 'utf8')
  const counts = observe(t, store)
  const duplicate = user(1)
  Object.defineProperty(duplicate.data, 'content', { get() { throw new Error('duplicate body must not be read') } })
  assert.equal(await store.projectEvent(session(), duplicate), null)
  await settle()
  assert.deepEqual(counts, { clones: 0, dirty: 0, saves: 0 })
  assert.equal(await readFile(dataFile, 'utf8'), before)
})

test('repeated tool calls and results leave completed status and timestamps unchanged', async t => {
  const { store, dataFile, settle } = await fixture(t)
  const events = [user(0), assistant(1), call(2), result(3)]
  await store.projectSession(session('s1', events))
  await settle()
  const before = await readFile(dataFile, 'utf8')
  const counts = observe(t, store)
  assert.equal(await store.projectEvents(session(), [call(2), result(3)]), null)
  assert.equal(await store.projectSession(session('s1', events)), null)
  await settle()
  assert.deepEqual(counts, { clones: 0, dirty: 0, saves: 0 })
  assert.equal(await readFile(dataFile, 'utf8'), before)
})

test('a mixed batch with a real update schedules exactly one save', async t => {
  const { store, settle } = await fixture(t)
  await store.projectSession(session('s1', [user(0)]))
  await settle()
  const counts = observe(t, store)
  const projected = await store.projectEvents(session(), [user(0), { type: 'step/start', seq: 1 }, assistant(2), call(3), result(4)])
  assert.equal(projected.messages.length, 2)
  assert.equal(projected.messages[1].process[0].status, 'done')
  assert.deepEqual(counts, { clones: 1, dirty: 1, saves: 0 })
  await settle()
  assert.equal(counts.saves, 1)
})

test('tool results before calls are retained and attached to the matching assistant', async t => {
  const { store, settle } = await fixture(t)
  await store.projectEvents(session(), [user(0), result(1, { message: '失败' })])
  await settle()
  const counts = observe(t, store)
  assert.equal(await store.projectEvent(session(), result(1, { message: '失败' })), null)
  assert.deepEqual(counts, { clones: 0, dirty: 0, saves: 0 })
  const thread = await store.projectEvents(session(), [call(2), assistant(3)])
  assert.equal(thread.pendingProcess.length, 0)
  assert.equal(thread.messages[1].process[0].name, 'shell')
  assert.equal(thread.messages[1].process[0].status, 'failed')
  await settle()
  assert.equal(counts.saves, 1)
})

test('unchanged titles do not touch timestamps, while a rename is saved', async t => {
  const { store, dataFile, settle } = await fixture(t)
  const title = { type: 'session/title', seq: 1, time: 2, data: { title: '项目分析' } }
  await store.projectEvents(session(), [user(0), title])
  await settle()
  const before = await readFile(dataFile, 'utf8')
  const counts = observe(t, store)
  assert.equal(await store.projectEvent(session(), { ...title, seq: 2, time: 99 }), null)
  await settle()
  assert.equal(await readFile(dataFile, 'utf8'), before)
  assert.deepEqual(counts, { clones: 0, dirty: 0, saves: 0 })
  const renamed = await store.projectEvent(session(), { ...title, seq: 3, time: 100, data: { title: '新标题' } })
  assert.equal(renamed.title, '新标题')
  await settle()
  assert.deepEqual(counts, { clones: 1, dirty: 1, saves: 1 })
})

test('identical session syncs skip saves while renames and removals remain visible', async t => {
  const { store, dataFile, settle } = await fixture(t)
  const sessions = [{ id: 'parent', cwd: 'C:\\projection', title: '主线' }, { id: 'child', cwd: 'C:\\projection', title: '分支', parentId: 'parent' }]
  await store.syncSessions(sessions)
  await settle()
  const before = await readFile(dataFile, 'utf8')
  const counts = observe(t, store)
  const summaries = await store.syncSessions(sessions)
  await store.syncSessions(sessions, ['unknown'])
  await settle()
  assert.equal(summaries[0].threadCount, 2)
  assert.deepEqual(counts, { clones: 0, dirty: 0, saves: 0 })
  assert.equal(await readFile(dataFile, 'utf8'), before)
  await store.syncSessions([{ ...sessions[0], title: '主线改名' }, sessions[1]])
  await settle()
  await store.syncSessions([sessions[1]], ['parent'])
  await settle()
  assert.equal((await store.list())[0].threadCount, 1)
  assert.equal(counts.dirty, 2)
  assert.equal(counts.saves, 2)
})

test('metadata and late parent repair are saved even without a new message', async t => {
  const { store, settle } = await fixture(t)
  const child = session('child')
  child.header.parentSession = 'parent'
  const first = await store.projectSession(child)
  await settle()
  const counts = observe(t, store)
  const parent = await store.projectSession(session('parent'))
  assert.equal((await store.threadsForSessions(['child']))[0].parentId, parent.id)
  await settle()
  child.inheritedEventCount = 7
  const updated = await store.projectSession(child)
  assert.equal(updated.id, first.id)
  assert.equal(updated.sourceSeedLength, 7)
  await settle()
  assert.equal(counts.dirty, 2)
  assert.equal(counts.saves, 2)
})

test('todo, cancellation and failure events remain projectable', async t => {
  const { store } = await fixture(t)
  const thread = await store.projectEvents(session(), [
    user(0),
    { type: 'todo/write', seq: 1, time: 2, data: { todos: [{ status: 'pending', content: '查资料' }] } },
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, step: 1, reason: { kind: 'cancelled' } } },
    { type: 'step/failed', seq: 3, time: 4, data: { error: { message: '连接失败' } } },
  ])
  assert.deepEqual(thread.messages.map(message => message.kind), ['user', 'todo', 'error', 'error'])
  assert.equal(thread.messages[2].text, '本轮已取消')
  assert.match(thread.messages[3].text, /连接失败/)
})

test('host filters before batching and skips unused thread clones for replay and live events', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'synapse-noop-host-'))
  const listeners = new Map()
  const routes = []
  const failures = []
  const stores = new Set()
  const originalReplay = WorkspaceStore.prototype.projectSession
  const originalBatch = WorkspaceStore.prototype.projectEvents
  const batches = []
  t.mock.method(WorkspaceStore.prototype, 'projectSession', function (...args) { stores.add(this); return originalReplay.apply(this, args) })
  t.mock.method(WorkspaceStore.prototype, 'projectEvents', function (...args) { stores.add(this); batches.push(args); return originalBatch.apply(this, args) })
  let clones = 0
  const clone = globalThis.structuredClone
  t.mock.method(globalThis, 'structuredClone', (...args) => { clones += 1; return clone(...args) })
  t.after(async () => {
    for (const store of stores) { clearTimeout(store.flushTimer); await store.serial; await store.flush() }
    await rm(directory, { recursive: true, force: true })
  })
  apply({
    logger: { warn(error) { failures.push(error) }, error(error) { failures.push(error) } },
    sessions: { list: () => [] },
    on(type, handler) { listeners.set(type, handler) },
    effect: effect => effect(),
    webServer: { register(route) { routes.push(route); return () => {} } },
  }, { dataFile: join(directory, 'state.json') })
  await routes.find(route => route.path === '/synapse/api').handler(
    { headers: { host: 'localhost' }, url: '/synapse/api/workspaces', method: 'GET' },
    { writeHead() {}, end() {} },
  )
  const active = session('s1', [user(0)])
  listeners.get('session/created')(active)
  await new Promise(resolve => setImmediate(resolve))
  for (let seq = 1; seq <= 1_000; seq += 1) listeners.get('session/event')(active, { type: 'step/start', seq })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(batches.length, 0)
  listeners.get('session/event')(active, assistant(1_001))
  listeners.get('session/event')(active, call(1_002))
  listeners.get('session/event')(active, result(1_003))
  await new Promise(resolve => setImmediate(resolve))
  for (const store of stores) { await store.serial; await store.flush() }
  assert.equal(batches.length, 1)
  assert.equal(batches[0][1].length, 3)
  assert.deepEqual(batches[0][3], { returnThread: false })
  assert.equal(clones, 0)
  assert.deepEqual(failures, [])
  const persisted = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
  assert.equal(persisted.workspaces[0].threads[0].messages[1].process[0].status, 'done')
})
