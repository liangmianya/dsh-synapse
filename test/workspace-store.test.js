import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkspaceStore } from '../index.js'

test('persists a workspace, a DSH-linked thread, and a message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-'))
  const dataFile = join(directory, 'state.json')
  const store = new WorkspaceStore(dataFile)
  const workspace = await store.create('调研 DSH 插件')
  const thread = await store.createThread(workspace.id, { title: 'DSH 会话', dshSessionId: 'session-1' })
  await store.addMessage(thread.id, '确定使用已有 Web Server')

  const saved = await new WorkspaceStore(dataFile).get(workspace.id)
  assert.equal(saved.title, '调研 DSH 插件')
  assert.equal(saved.threads[0].dshSessionId, 'session-1')
  assert.equal(saved.threads[0].messages[0].text, '确定使用已有 Web Server')
  assert.match(await readFile(dataFile, 'utf8'), /"version": ?4/)
})

test('projects committed DSH events once, folds tool process into the assistant card, and keeps fork lineage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-projection-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  const parent = {
    id: 'session-parent', header: {}, firstLiveSeq: 0,
    events: [
      { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '分析登录异常' }] } },
      { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '我来检查。' }] } } },
      { type: 'tool/call', seq: 2, time: 3, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"pnpm test"}' } },
      { type: 'tool/result', seq: 3, time: 4, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] } } },
    ],
  }
  await store.projectSession(parent)
  await store.projectEvent(parent, parent.events[2])
  const child = { id: 'session-child', header: { parentSession: 'session-parent' }, firstLiveSeq: 4, events: [] }
  await store.projectSession(child, child.firstLiveSeq)

  const [workspace] = await store.list()
  const graph = await store.get(workspace.id)
  const parentThread = graph.threads.find(thread => thread.dshSessionId === 'session-parent')
  const childThread = graph.threads.find(thread => thread.dshSessionId === 'session-child')
  assert.equal(workspace.title, 'DSH 任务')
  assert.equal(parentThread.messages.length, 2)
  assert.equal(parentThread.messages[0].kind, 'user')
  assert.equal(parentThread.messages[1].kind, 'assistant')
  assert.equal(parentThread.messages[1].process.length, 1)
  assert.equal(parentThread.messages[1].process[0].name, 'bash')
  assert.equal(parentThread.messages[1].process[0].result, 'ok')
  assert.equal(parentThread.messages[1].process[0].error, null)
  assert.equal(childThread.parentId, parentThread.id)
})

test('projects a batch of session events in a single write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-batch-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  const session = {
    id: 'session-batch', header: { meta: { cwd: 'C:\\work\\batch' } }, firstLiveSeq: 0,
    events: [
      { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '批量问题' }] } },
      { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '批量回答' }] } } },
      { type: 'tool/call', seq: 2, time: 3, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
      { type: 'tool/result', seq: 3, time: 4, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] } } },
    ],
  }
  await store.projectEvents(session, session.events)
  const [workspace] = await store.list()
  const graph = await store.get(workspace.id)
  const thread = graph.threads[0]
  assert.equal(thread.messages.length, 2)
  assert.equal(thread.messages[0].text, '批量问题')
  assert.equal(thread.messages[1].process.length, 1)
  assert.equal(thread.messages[1].process[0].result, 'ok')
  assert.match(await readFile(join(directory, 'state.json'), 'utf8'), /"version": ?4/)
})

test('retains a tool failure and exposes a failed turn without assistant text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-error-projection-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  await store.projectSession({
    id: 'session-error', header: { meta: { cwd: 'C:\\work\\errors' } }, firstLiveSeq: 0,
    events: [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '搜索竞品' }] } },
      { type: 'tool/call', seq: 2, time: 2, data: { turn: 7, step: 1, callId: 'search-1', name: 'web_search', arguments: '{"query":"竞品"}' } },
      { type: 'tool/result', seq: 3, time: 3, data: { turn: 7, step: 1, error: { name: 'QuotaExceeded', code: 'INSUFFICIENT_BALANCE', message: '余额不足' }, message: { source: { kind: 'tool', callId: 'search-1' }, content: [] } } },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 7, step: 1, reason: { kind: 'error', error: { name: 'QuotaExceeded', code: 'INSUFFICIENT_BALANCE', message: '余额不足' } } } },
    ],
  })

  const [workspace] = await store.list()
  const graph = await store.get(workspace.id)
  const [user, failure] = graph.threads[0].messages
  assert.equal(user.kind, 'user')
  assert.equal(failure.kind, 'error')
  assert.equal(failure.text, 'QuotaExceeded: INSUFFICIENT_BALANCE: 余额不足')
  assert.equal(failure.process.length, 1)
  assert.equal(failure.process[0].error, 'QuotaExceeded: INSUFFICIENT_BALANCE: 余额不足')
  assert.equal(graph.threads[0].pendingProcess.length, 0)
})

test('migrates v3 tool cards into the assistant process records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-migrate-'))
  const dataFile = join(directory, 'state.json')
  await writeFile(dataFile, JSON.stringify({
    version: 3,
    hiddenSessionIds: [],
    workspaces: [{
      id: 'w-1', kind: 'dsh', cwd: 'C:\\work\\migrate', title: 'migrate',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      threads: [{
        id: 't-1', title: '会话', parentId: null, dshSessionId: 's-1', dshSessionTitle: null,
        color: '#0f766e', position: { x: 86, y: 82 }, sourceSeedLength: null,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        messages: [
          { id: 'm-1', kind: 'user', text: '帮我检查', at: '2026-01-01T00:00:00.000Z' },
          { id: 'm-2', kind: 'assistant', text: '好的。', at: '2026-01-01T00:00:00.100Z' },
          { id: 'm-3', kind: 'tool', text: 'read\n{"file_path":"a.js"}', at: '2026-01-01T00:00:00.200Z' },
          { id: 'm-4', kind: 'tool-result', text: 'file content', at: '2026-01-01T00:00:00.300Z' },
          { id: 'm-5', kind: 'tool', text: 'bash\n{"cmd":"pwd"}', at: '2026-01-01T00:00:00.400Z' },
        ],
      }],
    }],
  }, null, 2))
  const store = new WorkspaceStore(dataFile)
  const graph = await store.get('w-1')
  const thread = graph.threads[0]
  assert.equal(thread.messages.length, 2)
  assert.equal(thread.messages[1].process.length, 2)
  assert.equal(thread.messages[1].process[0].name, 'read')
  assert.equal(thread.messages[1].process[0].arguments, '{"file_path":"a.js"}')
  assert.equal(thread.messages[1].process[0].result, 'file content')
  assert.equal(thread.messages[1].process[1].name, 'bash')
  assert.equal(thread.messages[1].process[1].result, null)
  assert.match(await readFile(dataFile, 'utf8'), /"version": ?4/)
})

test('does not persist DSH internal context as a user conversation turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-runtime-context-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  await store.projectSession({
    id: 'runtime-context', header: { meta: { cwd: 'C:\\work\\canvas' } }, firstLiveSeq: 0,
    events: [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '你好' }] } },
      { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\\nPolicy.' }] } },
      { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: '<system-reminder>Instructions from: AGENTS.md</system-reminder>' }] } },
      { type: 'assistant/message', seq: 4, time: 4, data: { message: { content: [{ type: 'text', text: '你好，我是助手。' }] } } },
    ],
  })

  const [workspace] = await store.list()
  const graph = await store.get(workspace.id)
  assert.deepEqual(graph.threads[0].messages.map(message => message.text), ['你好', '你好，我是助手。'])
})

test('removes persisted system reminders when loading an existing workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-system-reminder-'))
  const dataFile = join(directory, 'state.json')
  await writeFile(dataFile, JSON.stringify({
    version: 4,
    hiddenSessionIds: [],
    workspaces: [{
      id: 'w-1', kind: 'dsh', cwd: 'C:\\work\\canvas', title: 'canvas',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      threads: [{
        id: 't-1', title: '会话', parentId: null, dshSessionId: 's-1', dshSessionTitle: null,
        color: '#0f766e', position: { x: 86, y: 82 }, sourceSeedLength: null,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        messages: [
          { id: 'm-1', kind: 'user', text: '<system-reminder>Instructions from: AGENTS.md</system-reminder>', at: '2026-01-01T00:00:00.000Z' },
          { id: 'm-2', kind: 'user', text: '实际提问', at: '2026-01-01T00:00:01.000Z' },
        ],
      }],
    }],
  }))

  const store = new WorkspaceStore(dataFile)
  const graph = await store.get('w-1')
  assert.deepEqual(graph.threads[0].messages.map(message => message.text), ['实际提问'])
  assert.doesNotMatch(await readFile(dataFile, 'utf8'), /<system-reminder>/)
})

test('merges a browser fork callback with an already projected DSH fork', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-fork-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  const parent = { id: 'parent', header: {}, firstLiveSeq: 0, events: [] }
  const child = { id: 'child', header: { parentSession: 'parent' }, firstLiveSeq: 0, events: [] }
  const parentThread = await store.projectSession(parent)
  await store.projectSession(child, child.firstLiveSeq)
  const merged = await store.branch(parentThread.id, { title: '替代方案', dshSessionId: 'child', dshSessionTitle: '替代方案' })
  const [workspace] = await store.list()
  const graph = await store.get(workspace.id)
  assert.equal(graph.threads.length, 2)
  assert.equal(merged.dshSessionId, 'child')
  assert.equal(merged.parentId, parentThread.id)
})

test('groups DSH sessions by their working directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-cwd-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  await store.projectSession({ id: 'alpha', header: { meta: { cwd: 'C:\\work\\alpha' } }, firstLiveSeq: 0, events: [] })
  await store.projectSession({ id: 'beta', header: { meta: { cwd: 'C:\\work\\beta' } }, firstLiveSeq: 0, events: [] })
  const workspaces = await store.list()
  assert.equal(workspaces.length, 2)
  assert.deepEqual(new Set(workspaces.map(workspace => workspace.cwd)), new Set(['C:\\work\\alpha', 'C:\\work\\beta']))
})

test('syncs non-blank DSH sessions into the matching canvas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-sync-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  await store.syncSessions([
    { id: 'blank', title: '空会话', cwd: 'C:\\work\\canvas', blank: true },
    { id: 'parent', title: '主问题', cwd: 'C:\\work\\canvas', blank: false },
    { id: 'child', title: '替代路线', cwd: 'C:\\work\\canvas', parentId: 'parent', blank: false },
  ])
  const [workspace] = await store.list()
  const graph = await store.get(workspace.id)
  const parent = graph.threads.find(thread => thread.dshSessionId === 'parent')
  const child = graph.threads.find(thread => thread.dshSessionId === 'child')
  assert.equal(graph.threads.length, 2)
  assert.equal(parent.title, '主问题')
  assert.equal(child.parentId, parent.id)
})

test('keeps DSH projection coordinates neutral instead of stacking by historical session count', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-neutral-position-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  await store.syncSessions([
    { id: 'first', title: '第一条', cwd: 'C:\\work\\canvas', blank: false },
    { id: 'second', title: '第二条', cwd: 'C:\\work\\canvas', blank: false },
  ])
  const [workspace] = await store.list()
  const graph = await store.get(workspace.id)

  assert.deepEqual(graph.threads.map(thread => thread.position), [{ x: 86, y: 82 }, { x: 86, y: 82 }])
})

test('removes the canvas node when DSH removes the session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-removed-session-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  await store.syncSessions([{ id: 'removed', title: '将被归档', cwd: 'C:\\work\\canvas', blank: false }])
  await store.syncSessions([], ['removed'])
  assert.equal((await store.list()).length, 0)
})

test('removing a DSH node prevents replay from restoring it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-remove-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  const session = { id: 'remove-me', header: { meta: { cwd: 'C:\\work\\remove' } }, firstLiveSeq: 0, events: [] }
  const thread = await store.projectSession(session)
  await store.removeThread(thread.id)
  await store.projectSession(session)
  assert.equal((await store.list()).length, 0)
})

test('archived canvas nodes stay hidden during a later DSH session sync', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-archive-sync-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  const session = { id: 'archived', title: '已归档', cwd: 'C:\\work\\archive', blank: false }
  await store.syncSessions([session])
  const [workspace] = await store.list()
  const graph = await store.get(workspace.id)
  await store.removeThread(graph.threads[0].id)
  await store.syncSessions([session])
  assert.equal((await store.list()).length, 0)
})

test('does not rewrite an up-to-date v4 file on load', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-idempotent-'))
  const dataFile = join(directory, 'state.json')
  const state = {
    version: 4,
    hiddenSessionIds: [],
    workspaces: [{
      id: 'w-1', kind: 'dsh', cwd: 'C:\\work\\x', title: 'x',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      threads: [{
        id: 't-1', title: 's', parentId: null, dshSessionId: 's-1', dshSessionTitle: null,
        color: '#0f766e', position: { x: 86, y: 82 }, sourceSeedLength: null,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        messages: [{ id: 'm-1', kind: 'assistant', text: 'hi', sourceSeq: 1, at: '2026-01-01T00:00:00.000Z', process: [] }],
      }],
    }],
  }
  await writeFile(dataFile, JSON.stringify(state))
  const before = (await stat(dataFile)).mtimeMs
  await new Promise(resolve => setTimeout(resolve, 80))
  await new WorkspaceStore(dataFile).ready
  const after = (await stat(dataFile)).mtimeMs
  assert.equal(after, before)
})

test('coalesces deferred projection saves into one write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-debounce-'))
  const dataFile = join(directory, 'state.json')
  const store = new WorkspaceStore(dataFile)
  const session = { id: 's1', header: { meta: { cwd: 'C:\\work\\x' } }, firstLiveSeq: 0 }
  // Two deferred projections land inside one debounce window: no disk write yet.
  await store.projectEvents(session, [{ type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'a' }] } }])
  await store.projectEvents(session, [{ type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'b' }] } } }])
  const before = (await stat(dataFile)).mtimeMs
  await new Promise(resolve => setTimeout(resolve, 60))
  const mid = (await stat(dataFile)).mtimeMs
  assert.equal(mid, before)
  // A manual flush persists the coalesced state in one save.
  await store.flush()
  const after = (await stat(dataFile)).mtimeMs
  assert.notEqual(after, before)
  const parsed = JSON.parse(await readFile(dataFile, 'utf8'))
  assert.equal(parsed.workspaces[0].threads[0].messages.length, 2)
})

test('truncates over-long projections with a detail-view marker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-truncate-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  const session = { id: 's1', header: { meta: { cwd: 'C:\\work\\x' } }, firstLiveSeq: 0 }
  await store.projectEvents(session, [
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '问' }] } },
    { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'y'.repeat(9_000) }] } } },
  ])
  await store.flush()
  const [workspace] = await store.list()
  const graph = await store.get(workspace.id)
  const assistant = graph.threads[0].messages.find(message => message.kind === 'assistant')
  assert.equal(assistant.text.length, 8_000 + '\n——…（详情查看全文）'.length)
  assert.ok(assistant.text.endsWith('——…（详情查看全文）'))
})
