import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { SessionLogReader, WorkspaceStore, bodiesFromEvents } from '../index.js'

/**
 * Doubles the host `Session` surface the store reads. v0.1.7 dropped the
 * `session.events` getter for `snapshotEvents()`, moved the durable fork cut
 * from `header.seedLength` to `inheritedEventCount`, and removed `header.meta`.
 * @param fields - identity, header fields, and the recorded event log.
 * @returns a session double exposing the current contract.
 */
function hostSession(fields) {
  return { ...fields, snapshotEvents: () => fields.events ?? [] }
}

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
  assert.match(await readFile(dataFile, 'utf8'), /"version": ?5/)
})

test('refuses to load an unreadable data file, and never rewrites it', async () => {
  // An unreadable workspaces.json is the only copy of the canvas. An earlier
  // revision restored a .v5-backup copy over it and saved, which discarded what
  // the broken file still held and rolled the map back to a snapshot of unknown
  // age. The store must fail instead, and leave both files byte-identical.
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-broken-'))
  const dataFile = join(directory, 'state.json')
  const broken = '{"version":5,"workspaces":[{"id":"w1","threads":['
  const backup = JSON.stringify({ version: 5, hiddenSessionIds: [], workspaces: [] })
  await writeFile(dataFile, broken, 'utf8')
  await writeFile(`${dataFile}.v5-backup`, backup, 'utf8')

  const store = new WorkspaceStore(dataFile)
  await assert.rejects(store.ready, /synapse: cannot read/)
  // No mutation may run on a store whose state never loaded.
  await assert.rejects(store.create('x'), /synapse: cannot read/)

  assert.equal(await readFile(dataFile, 'utf8'), broken)
  assert.equal(await readFile(`${dataFile}.v5-backup`, 'utf8'), backup)
})
test('projects committed DSH events once, folds tool process into the assistant card, and keeps fork lineage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-projection-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  const parent = hostSession({
    id: 'session-parent', header: {}, inheritedEventCount: 0,
    events: [
      { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '分析登录异常' }] } },
      { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '我来检查。' }] } } },
      { type: 'tool/call', seq: 2, time: 3, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"pnpm test"}' } },
      { type: 'tool/result', seq: 3, time: 4, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] } } },
    ],
  })
  await store.projectSession(parent)
  await store.projectEvent(parent, parent.events[2])
  const child = hostSession({ id: 'session-child', header: { parentSession: 'session-parent' }, inheritedEventCount: 4, events: [] })
  await store.projectSession(child, child.inheritedEventCount)

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
  // v5 keeps only the status; the tool payload is reloaded on demand.
  assert.equal(parentThread.messages[1].process[0].status, 'done')
  assert.equal(parentThread.messages[1].process[0].arguments, undefined)
  assert.equal(childThread.parentId, parentThread.id)
})

test('projects a batch of session events in a single write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-batch-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  const session = hostSession({
    id: 'session-batch', header: { cwd: 'C:\\work\\batch' }, inheritedEventCount: 0,
    events: [
      { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '批量问题' }] } },
      { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '批量回答' }] } } },
      { type: 'tool/call', seq: 2, time: 3, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
      { type: 'tool/result', seq: 3, time: 4, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] } } },
    ],
  })
  await store.projectEvents(session, session.events)
  const [workspace] = await store.list()
  const graph = await store.get(workspace.id)
  const thread = graph.threads[0]
  assert.equal(thread.messages.length, 2)
  assert.equal(thread.messages[0].text, '批量问题')
  assert.equal(thread.messages[1].process.length, 1)
  assert.equal(thread.messages[1].process[0].status, 'done')
  assert.equal(thread.messages[1].process[0].result, undefined)
  assert.match(await readFile(join(directory, 'state.json'), 'utf8'), /"version": ?5/)
})

test('retains a tool failure and exposes a failed turn without assistant text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-error-projection-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  await store.projectSession(hostSession({
    id: 'session-error', header: { cwd: 'C:\\work\\errors' }, inheritedEventCount: 0,
    events: [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '搜索竞品' }] } },
      { type: 'tool/call', seq: 2, time: 2, data: { turn: 7, step: 1, callId: 'search-1', name: 'web_search', arguments: '{"query":"竞品"}' } },
      { type: 'tool/result', seq: 3, time: 3, data: { turn: 7, step: 1, error: { name: 'QuotaExceeded', code: 'INSUFFICIENT_BALANCE', message: '余额不足' }, message: { source: { kind: 'tool', callId: 'search-1' }, content: [] } } },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 7, step: 1, reason: { kind: 'error', error: { name: 'QuotaExceeded', code: 'INSUFFICIENT_BALANCE', message: '余额不足' } } } },
    ],
  }))

  const [workspace] = await store.list()
  const graph = await store.get(workspace.id)
  const [user, failure] = graph.threads[0].messages
  assert.equal(user.kind, 'user')
  assert.equal(failure.kind, 'error')
  assert.equal(failure.text, 'QuotaExceeded: INSUFFICIENT_BALANCE: 余额不足')
  assert.equal(failure.process.length, 1)
  assert.equal(failure.process[0].status, 'failed')
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
  // v5 migration drops the folded payload but keeps the pairing outcome.
  assert.equal(thread.messages[1].process[0].status, 'done')
  assert.equal(thread.messages[1].process[0].arguments, undefined)
  assert.equal(thread.messages[1].process[0].result, undefined)
  assert.equal(thread.messages[1].process[1].name, 'bash')
  assert.equal(thread.messages[1].process[1].status, 'pending')
  assert.match(await readFile(dataFile, 'utf8'), /"version": ?5/)
})

test('does not persist the DSH runtime context as a user conversation turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-runtime-context-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  await store.projectSession(hostSession({
    id: 'runtime-context', header: { cwd: 'C:\\work\\canvas' }, inheritedEventCount: 0,
    events: [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '你好' }] } },
      { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\\nPolicy.' }] } },
      { type: 'assistant/message', seq: 3, time: 3, data: { message: { content: [{ type: 'text', text: '你好，我是助手。' }] } } },
    ],
  }))

  const [workspace] = await store.list()
  const graph = await store.get(workspace.id)
  assert.deepEqual(graph.threads[0].messages.map(message => message.text), ['你好', '你好，我是助手。'])
})

test('projects a typed turn, not the harness instruction, runtime and time rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-injected-kinds-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  await store.projectSession(hostSession({
    id: 'injected-kinds', header: { cwd: 'C:\\work\\canvas' }, inheritedEventCount: 0,
    events: [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '我记得你看k1里面有讲了几个' }], source: { kind: 'user', rpcId: 'r-1' } } },
      { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '<system-reminder>\nThe following workspace instructions may be relevant' }], source: { kind: 'agent-instructions', form: 'instructions' } } },
      { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: '<system-reminder>\nThe following information describes your current session' }], source: { kind: 'runtime-context', form: 'snapshot' } } },
      { type: 'user/message', seq: 4, time: 4, data: { content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-11-14T19:01:24+08:00[Asia/Shanghai]' }], source: { kind: 'time-context', form: 'snapshot' } } },
      { type: 'tool/call', seq: 5, time: 5, data: { callId: 'call-1', name: 'pwsh', turn: 1, step: 1, arguments: '{"command":"ls"}' } },
      { type: 'assistant/message', seq: 6, time: 6, data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'think' }, { type: 'tool-call', name: 'pwsh', arguments: '{"command":"ls"}' }] } } },
      { type: 'assistant/message', seq: 7, time: 7, data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'README 里是 8 个。' }] } } },
    ],
  }))

  const [workspace] = await store.list()
  const thread = (await store.get(workspace.id)).threads[0]
  // One card, one answer: the injected rows never open a turn, and the tool-only
  // step keeps an empty body so its tool call still folds into the turn.
  assert.deepEqual(thread.messages.map(message => message.kind), ['user', 'assistant', 'assistant'])
  assert.deepEqual(thread.messages.map(message => message.text), ['我记得你看k1里面有讲了几个', '', 'README 里是 8 个。'])
  assert.deepEqual(thread.messages[1].process.map(entry => entry.name), ['pwsh'])
  assert.equal(thread.title, '我记得你看k1里面有讲了几个')
})

test('skips the harness skill catalogue instead of projecting it as a question', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-skill-catalog-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  await store.projectSession(hostSession({
    id: 'skill-catalog', header: { cwd: 'C:\\work\\canvas' }, inheritedEventCount: 0,
    events: [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '现在这个插件是 0.4.2 还是 0.4.1' }], source: { kind: 'user', rpcId: 'r-1' } } },
      {
        type: 'user/message', seq: 2, time: 2,
        data: {
          content: [{ type: 'text', text: '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n<available_skills>\n- `office-xlsx`\n</available_skills>' }],
          source: { kind: 'skill-catalog', form: 'catalog', entries: [] },
        },
      },
      { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '现在是 0.4.2。' }] } } },
    ],
  }))

  const [workspace] = await store.list()
  const graph = await store.get(workspace.id)
  const thread = graph.threads[0]
  // The catalogue never becomes a turn, so the answer stays on the real question
  // and the thread title comes from that question instead of the injected text.
  assert.deepEqual(thread.messages.map(message => message.kind), ['user', 'assistant'])
  assert.deepEqual(thread.messages.map(message => message.text), ['现在这个插件是 0.4.2 还是 0.4.1', '现在是 0.4.2。'])
  assert.equal(thread.title, '现在这个插件是 0.4.2 还是 0.4.1')
})

test('drops a stored skill catalogue card on load and rewrites the file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-catalog-prune-'))
  const dataFile = join(directory, 'state.json')
  const at = '2026-01-01T00:00:00.000Z'
  await writeFile(dataFile, JSON.stringify({
    version: 4,
    hiddenSessionIds: [],
    workspaces: [{
      id: 'w-1', kind: 'dsh', cwd: 'C:\\work\\x', title: 'x', createdAt: at, updatedAt: at,
      threads: [{
        id: 't-1', title: 's', parentId: null, dshSessionId: 's-1', dshSessionTitle: null,
        color: '#0f766e', position: { x: 86, y: 82 }, sourceSeedLength: null, createdAt: at, updatedAt: at,
        messages: [
          { id: 'm-1', kind: 'user', text: '真实提问', sourceSeq: 1, at, process: [] },
          { id: 'm-2', kind: 'user', text: '<system-reminder>\nA skill is a reusable set.<available_skills>- `x`</available_skills>', sourceSeq: 2, at, process: [] },
          { id: 'm-3', kind: 'assistant', text: '回答', sourceSeq: 3, at, process: [] },
          { id: 'm-4', kind: 'user', text: 'Time sampled while preparing turn 1, step 1: 2026-11-14T19:01:24+08:00[Asia/Shanghai]', sourceSeq: 4, at, process: [] },
        ],
      }],
    }],
  }))

  const store = new WorkspaceStore(dataFile)
  await store.ready
  const graph = await store.get('w-1')
  assert.deepEqual(graph.threads[0].messages.map(message => message.id), ['m-1', 'm-3'])
  const persisted = await readFile(dataFile, 'utf8')
  assert.ok(!persisted.includes('<available_skills>'))
})


test('merges a browser fork callback with an already projected DSH fork', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-fork-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  const parent = hostSession({ id: 'parent', header: {}, inheritedEventCount: 0, events: [] })
  const child = hostSession({ id: 'child', header: { parentSession: 'parent' }, inheritedEventCount: 0, events: [] })
  const parentThread = await store.projectSession(parent)
  await store.projectSession(child, child.inheritedEventCount)
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
  await store.projectSession(hostSession({ id: 'alpha', header: { cwd: 'C:\\work\\alpha' }, inheritedEventCount: 0, events: [] }))
  await store.projectSession(hostSession({ id: 'beta', header: { cwd: 'C:\\work\\beta' }, inheritedEventCount: 0, events: [] }))
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
  const session = hostSession({ id: 'remove-me', header: { cwd: 'C:\\work\\remove' }, inheritedEventCount: 0, events: [] })
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

test('does not rewrite an up-to-date v5 file on load', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-idempotent-'))
  const dataFile = join(directory, 'state.json')
  const state = {
    version: 5,
    hiddenSessionIds: [],
    workspaces: [{
      id: 'w-1', kind: 'dsh', cwd: 'C:\\work\\x', title: 'x',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      threads: [{
        id: 't-1', title: 's', parentId: null, dshSessionId: 's-1', dshSessionTitle: null,
        color: '#0f766e', position: { x: 86, y: 82 }, sourceSeedLength: null,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        messages: [{ id: 'm-1', kind: 'assistant', text: 'hi', length: 2, truncated: false, sourceSeq: 1, at: '2026-01-01T00:00:00.000Z', process: [] }],
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
  const session = hostSession({ id: 's1', header: { cwd: 'C:\\work\\x' }, inheritedEventCount: 0 })
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

test('stores only a preview of a long message and keeps its length', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-excerpt-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  const session = hostSession({ id: 's1', header: { cwd: 'C:\\work\\x' }, inheritedEventCount: 0 })
  await store.projectEvents(session, [
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '问' }] } },
    { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'y'.repeat(9_000) }] } } },
  ])
  await store.flush()
  const [workspace] = await store.list()
  const graph = await store.get(workspace.id)
  const assistant = graph.threads[0].messages.find(message => message.kind === 'assistant')
  // The body stays in the DSH session log; only a preview is persisted (#42).
  assert.equal(assistant.length, 9_000)
  assert.equal(assistant.truncated, true)
  assert.ok(assistant.text.length <= 281)
  assert.ok(assistant.text.endsWith('…'))
  assert.ok(Buffer.byteLength(JSON.stringify(assistant), 'utf8') < 600)
})

test('reloads message bodies from the session log on demand', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-bodies-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  const session = hostSession({
    id: 'session-bodies', header: { cwd: 'C:\\work\\bodies' }, inheritedEventCount: 0,
    events: [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '看看构建日志' }] } },
      { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: `长回答 ${'z'.repeat(4_000)}` }] } } },
      { type: 'tool/call', seq: 3, time: 3, data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"cmd":"pnpm build"}' } },
      { type: 'tool/result', seq: 4, time: 4, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'BUILD OK' }] } } },
    ],
  })
  await store.projectSession(session)
  const [workspace] = await store.list()
  const graph = await store.get(workspace.id)
  const thread = graph.threads[0]

  // The stored copy is a preview; the loader returns the whole body plus the
  // tool payload that the workspace file no longer keeps.
  assert.ok(thread.messages[1].truncated)
  const everything = bodiesFromEvents(thread, session.events, null)
  assert.equal(everything['2'].text.startsWith('长回答'), true)
  assert.equal(everything['2'].text.length, 4_000 + '长回答 '.length)
  assert.equal(everything['1'].text, '看看构建日志')
  assert.equal(everything['2'].process[0].arguments, '{"cmd":"pnpm build"}')
  assert.equal(everything['2'].process[0].result, 'BUILD OK')

  const subset = bodiesFromEvents(thread, session.events, [1])
  assert.deepEqual(Object.keys(subset), ['1'])
})

test('reads a closed session log from disk so its bodies stay available', { skip: typeof zstdCompressSync !== 'function' && 'zstd compression unavailable' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-session-log-'))
  const workspaceDirectory = join(directory, '--C-work--')
  const sessionId = 'session-closed'
  const sessionDirectory = join(workspaceDirectory, sessionId)
  await mkdir(sessionDirectory, { recursive: true })
  // DSH appends one zstd frame per flush, so a log is a run of frames.
  const frame = events => zstdCompressSync(Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8'))
  const log = Buffer.concat([
    frame([{ type: 'session', version: 4, id: sessionId }]),
    frame([
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '老问题' }] } },
      { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '老回答' }] } } },
    ]),
  ])
  await writeFile(join(sessionDirectory, 'session.v4.jsonl.zstd'), log)

  const reader = new SessionLogReader(directory)
  const events = await reader.events(sessionId)
  // Only sequenced events are returned; the header line that opens the log is skipped.
  assert.deepEqual(events.map(event => event.type), ['user/message', 'assistant/message'])
  assert.equal(await reader.events('session-missing'), null)

  // Second read is served from the mtime cache and stays correct.
  const cached = await reader.events(sessionId)
  assert.equal(cached.length, 2)

  const thread = { messages: [{ sourceSeq: 1, process: [] }, { sourceSeq: 2, process: [] }] }
  const bodies = bodiesFromEvents(thread, events, null)
  assert.equal(bodies['1'].text, '老问题')
  assert.equal(bodies['2'].text, '老回答')
})
