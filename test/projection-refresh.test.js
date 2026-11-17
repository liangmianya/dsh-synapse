import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
const snippet = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)))
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function harness() {
  let now = 1_000
  let renders = 0
  let cameraResets = 0
  const requests = []
  const summaries = [{ id: 'synapse-uuid-a', updatedAt: '1' }, { id: 'synapse-uuid-b', updatedAt: '1' }]
  const groups = [
    { id: 'dsh-uuid-a', title: '我的项目组', path: 'C:\\project', sessionIds: ['s-a', 's-b', 'missing'] },
    { id: 'dsh-uuid-b', title: '另一个组', path: 'C:\\other', sessionIds: ['s-c'] },
  ]
  let threads = [
    { id: 't-a', dshSessionId: 's-a', parentId: null, messages: [{ text: '旧消息' }] },
    { id: 't-b', dshSessionId: 's-b', parentId: null, messages: [] },
    { id: 't-c', dshSessionId: 's-c', parentId: null, messages: [] },
  ]
  let responder = async (path, options) => {
    if (path === '/synapse/api/workspaces') return { workspaces: summaries }
    if (path === '/synapse/api/threads/query') {
      const { sessionIds } = JSON.parse(options.body)
      return { threads: threads.filter(thread => sessionIds.includes(thread.dshSessionId)) }
    }
    throw new Error(`unexpected request: ${path}`)
  }
  const context = vm.createContext({
    TextEncoder,
    Date: class extends Date { static now() { return now } },
    document: { hidden: false, activeElement: null },
    window: { requestAnimationFrame() {} },
    state: {
      summaries: [], workspace: null, activeId: null, currentDsh: null,
      dshWorkspaces: groups, selectedDshWorkspaceId: null,
      draft: null, dragging: false, canvasGesture: false, canvasRefreshAfter: 0,
      workspaceLoad: 0, workspaceLoadBusy: false, workspaceLoadOwner: null,
      workspaceFingerprint: null, workspaceSummariesSignature: null, workspaceDshSignature: null, error: '',
      mapVisible: true,
    },
    async fetch(path, options) {
      requests.push({ path, options })
      const body = await responder(path, options)
      return { ok: true, status: 200, json: async () => plain(body) }
    },
    render() { renders += 1 },
    resetCanvasCamera() { cameraResets += 1 },
    loadThreadHistory: async () => {},
    revealConversationThread() {},
    conversationCards: threads => threads,
    prepareWorkspaceCaches() {},
    pruneWorkspaceCaches() {},
    hydrateBodies: async () => {},
  })
  vm.runInContext([
    snippet('async function api(', 'function post('),
    snippet('function canReplaceView()', 'function openNewSession()'),
    snippet('let polling = false', 'let liveRenderTimer'),
    snippet('async function pollProjection()', 'void pollProjection()'),
  ].join('\n'), context)
  return {
    context, requests, summaries, groups,
    setResponder(fn) { responder = fn },
    setThreads(value) { threads = value },
    setNow(value) { now = value },
    get renders() { return renders },
    get cameraResets() { return cameraResets },
  }
}

test('loads and refreshes a DSH group by session IDs with no workspace fan-out', async () => {
  const h = harness()
  await h.context.refreshProjection()
  const state = h.context.state
  assert.equal(state.workspace.id, 'dsh:dsh-uuid-a')
  assert.equal(state.workspace.title, '我的项目组')
  assert.equal(state.workspace.cwd, 'C:\\project')
  assert.deepEqual(plain(state.workspace.threads.map(thread => thread.id)), ['t-a', 't-b'])
  h.requests.length = 0
  h.summaries[0].updatedAt = '2'
  h.setThreads([{ id: 't-a', dshSessionId: 's-a', messages: [{ text: '新消息' }] }])
  const resets = h.cameraResets
  await h.context.refreshProjection()
  assert.deepEqual(h.requests.map(request => request.path), ['/synapse/api/workspaces', '/synapse/api/threads/query'])
  assert.equal(state.workspace.id, 'dsh:dsh-uuid-a')
  assert.equal(state.workspace.title, '我的项目组')
  assert.equal(state.workspace.threads[0].messages[0].text, '新消息')
  assert.equal(h.cameraResets, resets)
  h.requests.length = 0
  const renders = h.renders
  await h.context.refreshProjection()
  assert.deepEqual(h.requests.map(request => request.path), ['/synapse/api/workspaces'])
  assert.equal(h.renders, renders)
})

test('retries a failed payload even when summaries no longer change', async () => {
  const h = harness()
  await h.context.refreshProjection()
  const original = h.context.state.workspace
  h.summaries[0].updatedAt = '2'
  let fail = true
  h.setResponder(async path => {
    if (path.endsWith('/workspaces')) return { workspaces: h.summaries }
    if (fail) throw new Error('offline')
    return { threads: [{ id: 'recovered', dshSessionId: 's-a', messages: [] }] }
  })
  await assert.rejects(h.context.refreshProjection(), /offline/)
  assert.equal(h.context.state.workspace, original)
  fail = false
  await h.context.refreshProjection()
  assert.equal(h.context.state.workspace.threads[0].id, 'recovered')
})

test('updates membership and metadata when the backend summaries are unchanged', async () => {
  const h = harness()
  await h.context.refreshProjection()
  h.groups[0] = { ...h.groups[0], title: '改名后的组', sessionIds: ['s-b'] }
  h.requests.length = 0
  await h.context.refreshProjection()
  assert.equal(h.context.state.workspace.title, '改名后的组')
  assert.deepEqual(plain(h.context.state.workspace.threads.map(thread => thread.id)), ['t-b'])
  assert.equal(h.requests.filter(request => request.path.endsWith('/query')).length, 1)
})

test('a user switch wins over an older refresh response', async () => {
  const h = harness()
  await h.context.refreshProjection()
  h.summaries[0].updatedAt = '2'
  const oldRequest = deferred()
  h.setResponder(async (path, options) => {
    if (path.endsWith('/workspaces')) return { workspaces: h.summaries }
    if (JSON.parse(options.body).sessionIds.includes('s-a')) return oldRequest.promise
    return { threads: [{ id: 't-c', dshSessionId: 's-c', messages: [] }] }
  })
  const refresh = h.context.refreshProjection()
  await new Promise(resolve => setImmediate(resolve))
  await h.context.openDshWorkspace('dsh-uuid-b', { userInitiated: true })
  const selected = h.context.state.workspace
  oldRequest.resolve({ threads: [{ id: 'stale', dshSessionId: 's-a', messages: [] }] })
  await refresh
  assert.equal(h.context.state.workspace, selected)
  assert.equal(selected.id, 'dsh:dsh-uuid-b')
})

test('overlapping user switches keep the newer load protected until it finishes', async () => {
  const h = harness()
  const first = deferred()
  const second = deferred()
  h.setResponder(async (_path, options) => JSON.parse(options.body).sessionIds.includes('s-a') ? first.promise : second.promise)
  const loadA = h.context.openDshWorkspace('dsh-uuid-a', { userInitiated: true })
  const loadB = h.context.openDshWorkspace('dsh-uuid-b', { userInitiated: true })
  first.resolve({ threads: [] })
  assert.equal(await loadA, false)
  assert.equal(h.context.state.workspaceLoadBusy, true)
  assert.equal(h.context.state.workspaceLoadOwner, 'user')
  const count = h.requests.length
  await h.context.pollProjection()
  assert.equal(h.requests.length, count)
  second.resolve({ threads: [] })
  await loadB
  assert.equal(h.context.state.workspaceLoadBusy, false)
  assert.equal(h.context.state.workspaceLoadOwner, null)
})

test('poll failures are caught, back off up to 30 seconds, and clear only their own error', async () => {
  const h = harness()
  await h.context.refreshProjection()
  const original = h.context.state.workspace
  h.setResponder(async () => { throw new Error('server unavailable') })
  let now = 1_000
  for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    h.setNow(now)
    const count = h.requests.length
    await h.context.pollProjection()
    assert.equal(h.requests.length, count + 1)
    h.setNow(now + delay - 1)
    await h.context.pollProjection()
    assert.equal(h.requests.length, count + 1)
    now += delay
  }
  assert.match(h.context.state.error, /server unavailable/)
  assert.equal(h.context.state.workspace, original)
  h.setResponder(async () => ({ workspaces: h.summaries }))
  h.setNow(now)
  await h.context.pollProjection()
  assert.equal(h.context.state.error, '')
  h.setNow(now + 1_000)
  h.setResponder(async () => { throw new Error('another failure') })
  await h.context.pollProjection()
  h.context.state.error = '用户发送消息失败'
  h.setResponder(async () => ({ workspaces: h.summaries }))
  h.setNow(now + 3_000)
  await h.context.pollProjection()
  assert.equal(h.context.state.error, '用户发送消息失败')
})

test('switching groups bypasses the old group backoff and ignores its late error', async () => {
  const h = harness()
  await h.context.refreshProjection()
  h.setResponder(async () => { throw new Error('offline') })
  await h.context.pollProjection()
  h.context.state.selectedDshWorkspaceId = 'dsh-uuid-b'
  h.setResponder(async path => path.endsWith('/workspaces') ? { workspaces: h.summaries } : { threads: [] })
  await h.context.pollProjection()
  assert.equal(h.context.state.workspace.id, 'dsh:dsh-uuid-b')
  assert.equal(h.context.state.error, '')

  const pending = deferred()
  h.setResponder(() => pending.promise)
  const poll = h.context.pollProjection()
  h.context.state.selectedDshWorkspaceId = 'dsh-uuid-a'
  pending.resolve(Promise.reject(new Error('late error')))
  await poll
  assert.equal(h.context.state.error, '')
})

test('polls are single-flight and do not request data during gestures or hidden tabs', async () => {
  const h = harness()
  h.context.state.dshWorkspaces = []
  const pending = deferred()
  h.setResponder(() => pending.promise)
  const poll = h.context.pollProjection()
  await h.context.pollProjection()
  assert.equal(h.requests.length, 1)
  pending.resolve({ workspaces: [] })
  await poll
  for (const [object, key] of [[h.context.document, 'hidden'], [h.context.state, 'dragging'], [h.context.state, 'canvasGesture'], [h.context.state, 'workspaceLoadBusy']]) {
    const count = h.requests.length
    object[key] = true
    await h.context.pollProjection()
    object[key] = false
    assert.equal(h.requests.length, count)
  }
})

test('discards a refresh that completes during a gesture and retries it afterwards', async () => {
  const h = harness()
  await h.context.refreshProjection()
  const old = h.context.state.workspace
  h.summaries[0].updatedAt = '2'
  const pending = deferred()
  h.setResponder(async path => path.endsWith('/workspaces') ? { workspaces: h.summaries } : pending.promise)
  const refresh = h.context.refreshProjection()
  await new Promise(resolve => setImmediate(resolve))
  h.context.state.dragging = true
  pending.resolve({ threads: [] })
  await refresh
  assert.equal(h.context.state.workspace, old)
  h.context.state.dragging = false
  await h.context.refreshProjection()
  assert.equal(h.context.state.workspace.threads.length, 0)
})

test('recovers when a selected group is deleted', async () => {
  const h = harness()
  await h.context.refreshProjection()
  h.groups.shift()
  await h.context.refreshProjection()
  assert.equal(h.context.state.selectedDshWorkspaceId, 'dsh-uuid-b')
  assert.equal(h.context.state.workspace.id, 'dsh:dsh-uuid-b')
})

test('splits large session selectors within the API body limit', async () => {
  const h = harness()
  const ids = Array.from({ length: 2_000 }, (_, index) => `session-${index}-中文-${'a'.repeat(20)}`)
  h.setResponder(async (_path, options) => {
    assert.ok(Buffer.byteLength(options.body, 'utf8') <= 32 * 1024)
    return { threads: JSON.parse(options.body).sessionIds.map(id => ({ id, dshSessionId: id })) }
  })
  const result = await h.context.threadsForDshWorkspace({ sessionIds: [...ids, ids[0]] })
  assert.ok(h.requests.length > 1)
  assert.deepEqual(plain(result.map(thread => thread.dshSessionId)), ids)
})

test('API errors retain HTTP status for callers', async () => {
  const h = harness()
  h.context.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: '工作空间不存在' }) })
  await assert.rejects(h.context.api('/missing'), error => error.status === 404 && error.message === '工作空间不存在')
})
