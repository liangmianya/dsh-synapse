import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'
import vm from 'node:vm'
import { apply, WorkspaceStore } from '../index.js'
import { bodiesFromEvents, LOG_LIMITS, SessionLogReader } from '../session-bodies.js'

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
const cacheSource = await readFile(new URL('../browser-cache.js', import.meta.url), 'utf8')
const snippet = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)))
const textBlock = text => ({ type: 'text', text })
const user = (seq, text, sourceKind) => ({
  seq, time: seq + 1, type: 'user/message',
  data: { content: [textBlock(text)], ...(sourceKind === undefined ? {} : { source: { kind: sourceKind } }) },
})
const assistant = (seq, step, content, turn = 1) => ({
  seq, time: seq + 1, type: 'assistant/message', data: { turn, step, message: { content } },
})
const tool = (seq, step, callId, result = false) => ({
  seq, time: seq + 1, type: result ? 'tool/result' : 'tool/call',
  data: { turn: 1, step, ...(result
    ? { message: { source: { callId }, content: [textBlock(`结果-${callId}`)] } }
    : { callId, name: 'pwsh', arguments: `{"cmd":"${callId}"}` }) },
})
const events = () => [
  user(9, '真实问题', 'user'),
  user(10, '<system-reminder>工作区指令', 'agent-instructions'),
  user(11, '<system-reminder>另一份工作区指令', 'agent-instructions'),
  user(12, '<system-reminder>当前会话信息', 'runtime-context'),
  user(13, '<system-reminder><available_skills>目录', 'skill-catalog'),
  user(14, 'Time sampled while preparing turn 1', 'time-context'),
  assistant(20, 1, [{ type: 'reasoning', text: '思考' }, { type: 'tool-call', name: 'pwsh', arguments: '{"cmd":"c1"}' }, { type: 'tool-call', name: 'glob', arguments: '{}' }]),
  tool(21, 1, 'c1'), tool(22, 1, 'c1', true), tool(23, 1, 'c2'), tool(24, 1, 'c2', true),
  assistant(30, 2, [{ type: 'tool-call', name: 'read', arguments: '{}' }]),
  tool(31, 2, 'c3'), tool(32, 2, 'c3', true),
  assistant(38, 3, [{ type: 'tool-call', name: 'grep', arguments: '{}' }]),
  tool(39, 3, 'c4'), tool(40, 3, 'c4', true),
  assistant(44, 4, [{ type: 'tool-call', name: 'read', arguments: '{}' }]),
  tool(45, 4, 'c5'), tool(46, 4, 'c5', true),
  assistant(50, 5, [{ type: 'reasoning', text: '私有思考' }, textBlock('最终回答')]),
  assistant(51, 6, [{ type: 'reasoning', text: '没有回答正文' }]),
]

function oldThread(raw = events(), sessionId = 'session-old') {
  return {
    id: '11111111-1111-4111-8111-111111111111', dshSessionId: sessionId, dshSessionTitle: '自定义标题',
    title: '自定义标题', parentId: null, position: { x: 700, y: -120 }, color: '#2563eb',
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
    pendingProcess: [],
    messages: raw.flatMap(event => {
      if (event.type === 'user/message') {
        if (event.data.source?.kind === 'skill-catalog') return []
        return [{ id: `old-${event.seq}`, kind: 'user', sourceSeq: event.seq, text: event.data.content[0].text, at: new Date(event.time).toISOString() }]
      }
      if (event.type !== 'assistant/message') return []
      const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : block.type === 'tool-call' ? [block.name, block.arguments] : []).join('\n')
      if (!text) return []
      const process = raw.filter(item => item.type === 'tool/call' && item.data.step === event.data.step).map(item => ({
        callId: item.data.callId, name: item.data.name, turn: 1, step: item.data.step, status: 'done',
      }))
      return [{ id: `old-${event.seq}`, kind: 'assistant', sourceSeq: event.seq, text, at: new Date(event.time).toISOString(), turn: 1, step: event.data.step, process }]
    }),
  }
}

function canvas() {
  const state = { branchAnchors: new Map(), cardPositions: new Map(), liveReplies: new Map(),
    historyBySession: new Map(), pendingReplies: new Map(), collapsedCardIds: new Set() }
  const context = vm.createContext({ state, CARD_WIDTH: 310, CARD_HEIGHT: 276, CARD_GAP_Y: 42,
    CAMERA_INSET_X: 56, CAMERA_INSET_Y: 56, hydratedMessage: (_thread, message) => message })
  vm.runInContext([
    cacheSource,
    snippet('function messagesFromEvents', 'async function loadThreadHistory'),
    snippet('function persistedMessagesFor', 'function latestMessage'),
    snippet('function overlapsCard', 'function conversationGraphView'),
  ].join('\n'), context)
  return { state, cards: threads => context.conversationCards(threads), context }
}

async function fixture(t, threads = [oldThread()]) {
  const directory = await mkdtemp(join(tmpdir(), 'synapse-real-turns-'))
  const dataFile = join(directory, 'state.json')
  const original = { version: 5, hiddenSessionIds: [], workspaces: [{
    id: '22222222-2222-4222-8222-222222222222', kind: 'dsh', cwd: 'C:\\test', title: '测试',
    createdAt: threads[0].createdAt, updatedAt: threads[0].updatedAt, threads,
  }] }
  await writeFile(dataFile, JSON.stringify(original))
  const stores = []
  const store = new WorkspaceStore(dataFile)
  stores.push(store)
  const reader = new SessionLogReader(directory)
  await store.ready
  t.after(async () => {
    for (const item of stores) { await item.serial; await item.flush(); clearTimeout(item.flushTimer) }
    await rm(directory, { recursive: true, force: true })
  })
  async function put(id, raw) {
    const path = join(directory, 'workspace', id)
    await mkdir(path, { recursive: true })
    const data = Buffer.isBuffer(raw) ? raw : zstdCompressSync(Buffer.from(raw.map(event => JSON.stringify(event)).join('\n') + '\n'))
    await writeFile(join(path, 'session.v4.jsonl.zstd'), data)
  }
  const get = async (id = 'session-old') => (await store.threadsForSessions([id]))[0]
  return { directory, dataFile, stores, store, reader, original, put, get }
}

test('new projection counts only real user turns, including source-less imports and future injection types', async t => {
  const f = await fixture(t, [oldThread([], 'new')])
  const raw = [...events(), user(60, '新型系统注入', 'future-injection'), user(61, '导入提问'),
    assistant(62, 7, [textBlock('导入回答')]), user(70, '<system-reminder>用户自己引用指令', 'user')]
  const session = { id: 'new', header: { cwd: 'C:\\test' }, inheritedEventCount: 0, snapshotEvents: () => raw }
  const thread = await f.store.projectSession(session)
  const cards = canvas().cards([thread])
  assert.equal(cards.length, 3)
  assert.equal(cards[0].answer.text, '最终回答')
  assert.equal(cards[0].processCount, 5)
  assert.equal(cards[1].question, '导入提问')
  assert.equal(cards[2].question, '<system-reminder>用户自己引用指令')
  assert.equal(thread.messages.find(message => message.sourceSeq === 20).text, '')
  assert.equal(thread.messages.find(message => message.sourceSeq === 51).text, '')
})

test('first installation imports existing sessions and forks, then keeps live turns correct across restart', async t => {
  const f = await fixture(t)
  await rm(f.dataFile)
  const store = new WorkspaceStore(f.dataFile)
  f.stores.push(store)
  const raw = [...events(),
    user(60, '[model changed: old model; continuing with another model]', 'model-selection'),
    user(61, 'The approval policy changed from "ask" to "never".', 'user-approval'),
    user(62, '新类型的系统提示', 'future-injection'),
    user(63, '[model changed: 用户自己引用的内容]', 'user'),
    assistant(64, 7, [textBlock('引用内容的回答')]),
    user(65, 'Time sampled while preparing: 合法的无来源导入提问'),
    assistant(66, 8, [textBlock('导入内容的回答')])]
  const childRaw = [...raw, user(90, '分支问题', 'user'),
    user(91, 'Time sampled while preparing fork', 'time-context'),
    assistant(92, 9, [textBlock('分支回答')])]
  const parent = { id: 'parent', title: '已有会话', header: { cwd: 'C:\\test' },
    inheritedEventCount: 0, snapshotEvents: () => raw }
  const child = { id: 'child', title: '已有分支', header: { cwd: 'C:\\test', parentSession: 'parent' },
    inheritedEventCount: 90, snapshotEvents: () => childRaw }
  // A fresh install has no Synapse data. DSH may restore children first.
  await store.projectSession(child, child.inheritedEventCount)
  await store.projectSession(parent)
  await store.syncSessions([{ id: 'parent', cwd: 'C:\\test', title: parent.title },
    { id: 'child', cwd: 'C:\\test', title: child.title, parentId: 'parent' }])
  const threads = await store.threadsForSessions(['parent', 'child'])
  const parentThread = threads.find(thread => thread.dshSessionId === 'parent')
  const childThread = threads.find(thread => thread.dshSessionId === 'child')
  const cards = canvas().cards([parentThread, childThread])
  assert.deepEqual(Array.from(cards, card => card.question), ['真实问题', '[model changed: 用户自己引用的内容]',
    'Time sampled while preparing: 合法的无来源导入提问', '分支问题'])
  assert.equal(cards[0].answer.text, '最终回答')
  assert.equal(cards[0].processCount, 5)
  assert.equal(childThread.parentId, parentThread.id)
  assert.equal(childThread.messages[0].sourceSeq, 90)
  assert.equal(parentThread.messages.find(message => message.sourceSeq === 65).sourceVerified, true)
  const live = [user(80, '安装后的新问题', 'user'),
    user(81, '审批策略变化', 'user-approval'), assistant(82, 10, [textBlock('新问题的回答')])]
  await store.projectEvents(parent, live)
  raw.push(...live)
  await store.flush()
  const before = await readFile(f.dataFile, 'utf8')
  const reopened = new WorkspaceStore(f.dataFile)
  f.stores.push(reopened)
  await reopened.repairStoredSessions({ scan() { throw new Error('fresh imports must not require legacy repair') } })
  assert.equal(await reopened.projectSession(parent), null)
  assert.equal(await reopened.projectSession(child, child.inheritedEventCount), null)
  await reopened.flush()
  assert.equal(await readFile(f.dataFile, 'utf8'), before)
  const [updated] = await reopened.threadsForSessions(['parent'])
  const updatedCards = canvas().cards([updated])
  assert.equal(updatedCards.length, 4)
  assert.equal(updatedCards.at(-1).question, '安装后的新问题')
  assert.equal(updatedCards.at(-1).answer.text, '新问题的回答')
})

test('old five-card index becomes one real turn, retaining IDs, tools, metadata and saved card position', async t => {
  const f = await fixture(t)
  const raw = events()
  await f.put('session-old', raw)
  const h = canvas()
  assert.equal(h.cards([await f.get()]).length, 5)
  h.state.cardPositions.set(`${oldThread().id}:turn:9`, { x: 900, y: 430 })
  await f.store.repairStoredSessions(f.reader)
  const thread = await f.get()
  const cards = h.cards([thread])
  assert.equal(cards.length, 1)
  assert.equal(cards[0].id, `${oldThread().id}:turn:9`)
  assert.equal(cards[0].answer.text, '最终回答')
  assert.equal(cards[0].processCount, 5)
  assert.equal(cards[0].position.x, 900)
  assert.equal(cards[0].position.y, 430)
  for (const key of ['id', 'title', 'dshSessionTitle', 'parentId', 'position', 'color', 'createdAt']) assert.deepEqual(thread[key], oldThread()[key])
  assert.equal(thread.messages[0].id, 'old-9')
  assert.equal(thread.messages.find(message => message.sourceSeq === 50).id, 'old-50')
  assert.equal(thread.projectionVersion, 2)
  assert.equal(thread.pendingProcess.length, 0)
  const body = bodiesFromEvents(thread, raw, [20])['20']
  assert.equal(body.text, '')
  assert.equal(body.process[0].arguments, '{"cmd":"c1"}')
  assert.equal(body.process[0].result, '结果-c1')
  assert.deepEqual(JSON.parse(await readFile(`${f.dataFile}.projection-v2-backup`, 'utf8')), f.original)
  await f.store.flush()
  const before = await readFile(f.dataFile, 'utf8')
  const reopened = new WorkspaceStore(f.dataFile)
  f.stores.push(reopened)
  await reopened.repairStoredSessions({ scan() { throw new Error('completed repair must not read again') } })
  await reopened.flush()
  assert.equal(await readFile(f.dataFile, 'utf8'), before)
})

test('missing logs and unmatched sequences survive; an available log can repair them later', async t => {
  const old = oldThread()
  old.messages.push({ id: 'note', kind: 'user', text: '本地笔记' })
  old.messages.push({ id: 'unmatched', kind: 'user', text: '日志中暂缺的真提问', sourceSeq: 100 })
  const f = await fixture(t, [old])
  await f.store.repairStoredSessions(f.reader)
  assert.deepEqual(await f.get(), old)
  await f.put('session-old', events())
  await f.store.repairStoredSessions(f.reader)
  let thread = await f.get()
  assert.equal(thread.projectionVersion, undefined)
  assert.ok(thread.messages.some(message => message.id === 'note'))
  assert.ok(thread.messages.some(message => message.id === 'unmatched'))
  await f.put('session-old', [...events(), user(100, '日志中暂缺的真提问', 'user')])
  await f.store.repairStoredSessions(f.reader)
  thread = await f.get()
  assert.equal(thread.projectionVersion, 2)
  assert.equal(thread.messages.find(message => message.sourceSeq === 100).id, 'unmatched')
  assert.ok(thread.messages.some(message => message.id === 'note'))
})

test('completed v2 projections are repaired again when older code appended unverified notices', async t => {
  const raw = [...events(),
    user(60, '[model changed: previous model; continuing with another model]', 'model-selection'),
    user(61, 'The approval policy changed from "ask" to "never" (changed by the user).', 'user-approval')]
  const old = { ...oldThread(raw), projectionVersion: 2, sourceSeedLength: 0 }
  const f = await fixture(t, [old])
  assert.equal((await f.get()).projectionVersion, null)
  await f.put('session-old', raw)
  await f.store.repairStoredSessions(f.reader)
  const thread = await f.get()
  assert.equal(thread.projectionVersion, 2)
  assert.equal(canvas().cards([thread]).length, 1)
  assert.equal(canvas().cards([thread])[0].answer.text, '最终回答')
  assert.equal(canvas().cards([thread])[0].processCount, 5)
  assert.equal(thread.messages[0].id, 'old-9')
  for (const key of ['id', 'title', 'dshSessionTitle', 'parentId', 'sourceSeedLength', 'position', 'color', 'createdAt']) assert.deepEqual(thread[key], old[key])
  await f.store.flush()
  // Simulate an old plugin reintroducing one notice without clearing v2.
  const contaminated = JSON.parse(await readFile(f.dataFile, 'utf8'))
  contaminated.workspaces[0].threads[0].messages.push(old.messages.find(message => message.sourceSeq === 14))
  await writeFile(f.dataFile, JSON.stringify(contaminated))
  const reopened = new WorkspaceStore(f.dataFile)
  f.stores.push(reopened)
  await reopened.repairStoredSessions(f.reader)
  const [repaired] = await reopened.threadsForSessions(['session-old'])
  assert.equal(repaired.projectionVersion, 2)
  assert.equal(canvas().cards([repaired]).length, 1)
  assert.equal(canvas().cards([repaired])[0].processCount, 5)
})

test('verified source-less imports and local notes do not rescan on the next startup', async t => {
  const raw = [user(1, 'Time sampled while preparing: 用户引用的文本'),
    assistant(2, 1, [textBlock('回答')]),
    user(3, '[model changed: 用户自己引用]', 'user')]
  const old = { ...oldThread(raw), projectionVersion: 2 }
  old.messages.push({ id: 'note', kind: 'user', text: '本地笔记' })
  const f = await fixture(t, [old])
  await f.put('session-old', raw)
  await f.store.repairStoredSessions(f.reader)
  const thread = await f.get()
  assert.equal(thread.messages.find(message => message.sourceSeq === 1).sourceVerified, true)
  assert.equal(thread.messages.find(message => message.sourceSeq === 3).sourceKind, 'user')
  assert.ok(thread.messages.some(message => message.id === 'note'))
  assert.equal(canvas().cards([thread]).length, 3)
  await f.store.flush()
  const before = await readFile(f.dataFile, 'utf8')
  const reopened = new WorkspaceStore(f.dataFile)
  f.stores.push(reopened)
  await reopened.repairStoredSessions({ scan() { throw new Error('verified imports and local notes must not rescan') } })
  await reopened.flush()
  assert.equal(await readFile(f.dataFile, 'utf8'), before)
})

test('invalidating a completed repair never removes unverified rows when its log is incomplete', async t => {
  const old = { ...oldThread(), projectionVersion: 2 }
  const f = await fixture(t, [old])
  const before = await f.get()
  assert.equal(before.projectionVersion, null)
  await f.store.repairStoredSessions(f.reader)
  assert.deepEqual(await f.get(), before)
  const frame = zstdCompressSync(Buffer.from(events().map(event => JSON.stringify(event)).join('\n') + '\n'))
  await f.put('session-old', Buffer.concat([frame, frame.subarray(0, 8)]))
  await f.store.repairStoredSessions(f.reader)
  assert.deepEqual(await f.get(), before)
  await f.put('session-old', zstdCompressSync(Buffer.from(JSON.stringify(events()[0]) + '\n{invalid}\n')))
  await assert.rejects(f.store.repairStoredSessions(f.reader), SyntaxError)
  assert.deepEqual(await f.get(), before)
})

test('source-less imported messages and explicit user quotes are preserved when repairing old data', async t => {
  const raw = [user(1, '<system-reminder><available_skills>用户引用的内容'),
    assistant(2, 1, [textBlock('回答')]),
    user(3, 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.', 'user')]
  const f = await fixture(t, [oldThread(raw)])
  await f.put('session-old', raw)
  await f.store.repairStoredSessions(f.reader)
  const thread = await f.get()
  assert.equal(canvas().cards([thread]).length, 2)
  assert.equal(thread.messages[0].id, 'old-1')
  const parsed = canvas().context.messagesFromEvents(raw)
  assert.equal(parsed.filter(message => message.kind === 'user').length, 2)
})

test('loading stored provenance filters injections while preserving unverified quoted content', async t => {
  const old = oldThread()
  old.messages = [
    { id: 'real', kind: 'user', sourceKind: 'user', text: '<system-reminder>用户引用', sourceSeq: 1 },
    { id: 'injected', kind: 'user', sourceKind: 'future-injection', text: '系统信息', sourceSeq: 2 },
    { id: 'unknown', kind: 'user', text: '<system-reminder><available_skills>旧导入内容', sourceSeq: 3 },
  ]
  const f = await fixture(t, [old])
  assert.deepEqual((await f.get()).messages.map(message => message.id), ['real', 'unknown'])
})

test('partial, malformed and oversized logs do not change the old index', async t => {
  const f = await fixture(t)
  const frame = zstdCompressSync(Buffer.from(events().map(event => JSON.stringify(event)).join('\n') + '\n'))
  await f.put('session-old', Buffer.concat([frame, frame.subarray(0, 8)]))
  await f.store.repairStoredSessions(f.reader)
  assert.deepEqual(await f.get(), oldThread())
  await f.put('session-old', zstdCompressSync(Buffer.from(JSON.stringify(events()[0]) + '\n{invalid}\n')))
  await assert.rejects(f.store.repairStoredSessions(f.reader), SyntaxError)
  assert.deepEqual(await f.get(), oldThread())
  await f.put('session-old', frame)
  await assert.rejects(f.store.repairStoredSessions(new SessionLogReader(f.directory, { compressedBytes: 8 })), /读取上限/)
  assert.deepEqual(await f.get(), oldThread())
})

test('a broken session does not stop repairs of other sessions when a failure reporter is provided', async t => {
  const broken = oldThread(events(), 'broken')
  const good = { ...oldThread(), id: '33333333-3333-4333-8333-333333333333' }
  const f = await fixture(t, [broken, good])
  await f.put('broken', zstdCompressSync(Buffer.from('{bad}\n')))
  await f.put('session-old', events())
  const failures = []
  await f.store.repairStoredSessions(f.reader, error => failures.push(error))
  assert.equal(failures.length, 1)
  assert.deepEqual(await f.get('broken'), broken)
  assert.equal(canvas().cards([await f.get()]).length, 1)
})

test('fork repair excludes inherited turns and preserves the child relation', async t => {
  const raw = [user(1, '父问题', 'user'), assistant(2, 1, [textBlock('父回答')]), ...events()]
  const old = { ...oldThread(raw), projectionVersion: 2, sourceSeedLength: 9, parentId: 'parent-thread', sourceParentSessionId: 'parent-session' }
  const f = await fixture(t, [old])
  await f.put('session-old', raw)
  await f.store.repairStoredSessions(f.reader)
  const thread = await f.get()
  assert.equal(canvas().cards([thread]).length, 1)
  assert.equal(thread.messages[0].sourceSeq, 9)
  assert.equal(thread.parentId, 'parent-thread')
})

test('fork repair streams an inherited frame larger than the body allocation cap', async t => {
  const inherited = Array.from({ length: 34 }, (_, seq) => ({
    seq, time: seq + 1, type: 'session/context', data: { text: 'x'.repeat(256 * 1024) },
  }))
  const own = [user(40, '分支问题', 'user'),
    user(41, 'Time sampled while preparing turn', 'time-context'),
    user(42, '[model changed: previous model]', 'model-selection'),
    assistant(43, 1, [textBlock('分支回答')])]
  const old = { ...oldThread(own), projectionVersion: 2, sourceSeedLength: 40,
    parentId: 'parent-thread', sourceParentSessionId: 'parent-session' }
  const f = await fixture(t, [old])
  const history = Buffer.from(inherited.map(event => JSON.stringify(event)).join('\n') + '\n')
  assert.ok(history.length > LOG_LIMITS.frameBytes)
  assert.ok(history.length < LOG_LIMITS.decodedBytes)
  await f.put('session-old', Buffer.concat([zstdCompressSync(history),
    zstdCompressSync(Buffer.from(own.map(event => JSON.stringify(event)).join('\n') + '\n'))]))
  await f.store.repairStoredSessions(f.reader)
  const thread = await f.get()
  assert.equal(thread.projectionVersion, 2)
  assert.equal(thread.parentId, old.parentId)
  assert.equal(thread.messages[0].id, 'old-40')
  assert.equal(canvas().cards([thread]).length, 1)
  assert.equal(canvas().cards([thread])[0].answer.text, '分支回答')
  assert.equal(f.reader.cacheBytes, 0)
  assert.equal(f.reader.activeReads, 0)
  // On-demand bodies keep the stricter allocation cap.
  await assert.rejects(f.reader.events('session-old'), /读取上限/)
})

test('streaming repair enforces total and line budgets without committing a partial result', async t => {
  const f = await fixture(t, [{ ...oldThread(), projectionVersion: 2 }])
  const before = await f.get()
  const valid = Buffer.from(events().map(event => JSON.stringify(event)).join('\n') + '\n')
  const first = Buffer.from(JSON.stringify(events()[0]) + '\n')
  const rest = valid.subarray(first.length)
  const cases = [
    [{ decodedBytes: valid.length - 1 }, zstdCompressSync(valid)],
    [{ decodedBytes: valid.length - 1 }, Buffer.concat([zstdCompressSync(first), zstdCompressSync(rest)])],
    [{ lineBytes: 100 }, zstdCompressSync(Buffer.from(JSON.stringify(user(1, 'x'.repeat(70_000), 'user')) + '\n'))],
  ]
  // A frame without a declared content size must hit the streaming byte cap.
  const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0])
  const block = Buffer.alloc(3)
  block.writeUIntLE((first.length << 3) | 1, 0, 3)
  cases.push([{ decodedBytes: 1024 }, Buffer.concat(Array.from({ length: 20 },
    () => Buffer.concat([header, block, first])))])
  for (const [limits, data] of cases) {
    await f.put('session-old', data)
    const reader = new SessionLogReader(f.directory, limits)
    await assert.rejects(f.store.repairStoredSessions(reader), /读取上限/)
    assert.deepEqual(await f.get(), before)
    assert.equal(reader.activeReads, 0)
    assert.equal(reader.waiters.length, 0)
    assert.equal(reader.cacheBytes, 0)
  }
})

test('legacy forks without a saved seed do not acquire earlier inherited questions', async t => {
  const old = { ...oldThread(), sourceSeedLength: null, parentId: 'parent-thread', sourceParentSessionId: 'parent-session' }
  const f = await fixture(t, [old])
  await f.put('session-old', [user(1, '父问题', 'user'), assistant(2, 1, [textBlock('父回答')]), ...events()])
  await f.store.repairStoredSessions(f.reader)
  const thread = await f.get()
  assert.equal(canvas().cards([thread]).length, 1)
  assert.equal(thread.messages[0].sourceSeq, 9)
})

test('repair scans accept split UTF-8 lines, concatenated frames and skippable trailers', async t => {
  const raw = [user(1, '中文😀问题', 'user'), assistant(2, 1, [textBlock('回答')])]
  const f = await fixture(t, [oldThread(raw)])
  const line = Buffer.from(raw.map(event => JSON.stringify(event)).join('\n'))
  const split = line.indexOf(Buffer.from('😀')) + 2
  const skip = Buffer.alloc(11)
  skip.writeUInt32LE(0x184d2a50)
  skip.writeUInt32LE(3, 4)
  await f.put('session-old', Buffer.concat([
    zstdCompressSync(line.subarray(0, split)), zstdCompressSync(line.subarray(split)), skip,
  ]))
  await f.store.repairStoredSessions(f.reader)
  const thread = await f.get()
  assert.equal(thread.projectionVersion, 2)
  assert.equal(canvas().cards([thread])[0].question, '中文😀问题')
})

test('streaming scans preserve UTF-8 across output chunks and accept a final line without newline', async t => {
  const raw = [user(1, '中😀'.repeat(12_000), 'user'), user(2, '最后一行', 'user')]
  const f = await fixture(t, [oldThread(raw)])
  await f.put('session-old', zstdCompressSync(Buffer.from(raw.map(event => JSON.stringify(event)).join('\n'))))
  const visited = []
  assert.equal(await f.reader.scan('session-old', event => visited.push(event)), true)
  assert.deepEqual(visited, raw)
  assert.equal(f.reader.cacheBytes, 0)
  assert.equal(f.reader.activeReads, 0)
})

test('live replay repairs legacy rows before dedupe and does not duplicate tools on a second replay', async t => {
  const f = await fixture(t)
  const session = { id: 'session-old', header: { cwd: 'C:\\test' }, inheritedEventCount: 0, snapshotEvents: events }
  const thread = await f.store.projectSession(session)
  assert.equal(canvas().cards([thread]).length, 1)
  assert.equal(canvas().cards([thread])[0].processCount, 5)
  await f.store.flush()
  const before = await readFile(f.dataFile, 'utf8')
  assert.equal(await f.store.projectSession(session), null)
  await f.store.flush()
  assert.equal(await readFile(f.dataFile, 'utf8'), before)
})

test('live replay repairs a completed but contaminated v2 projection before deduplication', async t => {
  const f = await fixture(t, [{ ...oldThread(), projectionVersion: 2 }])
  const session = { id: 'session-old', header: { cwd: 'C:\\test' }, inheritedEventCount: 0, snapshotEvents: events }
  const thread = await f.store.projectSession(session)
  assert.equal(thread.projectionVersion, 2)
  assert.equal(canvas().cards([thread]).length, 1)
  assert.equal(canvas().cards([thread])[0].processCount, 5)
  assert.equal(await f.store.projectSession(session), null)
})

test('execution-only sessions create no turn; empty assistant steps do not settle a pending real question', () => {
  const h = canvas()
  assert.equal(h.cards([{ id: 't', dshSessionId: 's', parentId: null, messages: [
    { kind: 'user', sourceKind: 'time-context', text: '注入' }, { kind: 'assistant', text: '', process: [{ callId: 'tool' }] },
  ] }]).length, 0)
  const thread = { id: 't', dshSessionId: 's', parentId: null, messages: [
    { kind: 'user', text: '问题', sourceSeq: 1, at: new Date(1).toISOString() }, { kind: 'assistant', text: '', process: [{ callId: 'tool' }] },
  ] }
  h.state.pendingReplies.set('s', { text: '问题', at: 1 })
  h.state.liveReplies.set('s', { text: '正在回复', running: true })
  const [card] = h.cards([thread])
  assert.equal(card.processCount, 1)
  assert.equal(card.answer.text, '正在回复')
  assert.ok(h.state.pendingReplies.has('s'))
})

test('closed-session startup repair and full bodies work through a real HTTP server', async t => {
  const f = await fixture(t)
  await f.put('session-old', events())
  const routes = []
  const failures = []
  let completion
  const repair = WorkspaceStore.prototype.repairStoredSessions
  t.mock.method(WorkspaceStore.prototype, 'repairStoredSessions', function (...args) {
    f.stores.push(this)
    completion = repair.apply(this, args)
    return completion
  })
  apply({
    logger: { warn: error => failures.push(error), error: error => failures.push(error) },
    sessions: { list: () => [] }, on() {}, effect: fn => fn(),
    webServer: { register(route) { routes.push(route); return () => {} } },
  }, { dataFile: f.dataFile, sessionsDir: f.directory })
  await completion
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    const route = routes.find(route => route.kind === 'exact' ? path === route.path : path.startsWith(route.path))
    if (!route) { res.writeHead(404); res.end(); return }
    void route.handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const response = await fetch(`${origin}/synapse/api/threads/query`, {
    method: 'POST', body: JSON.stringify({ sessionIds: ['session-old'] }),
  })
  assert.equal(response.status, 200)
  const { threads } = await response.json()
  assert.equal(canvas().cards(threads).length, 1)
  const bodyResponse = await fetch(`${origin}/synapse/api/threads/${threads[0].id}/full?seqs=20,50`)
  assert.equal(bodyResponse.status, 200)
  const body = await bodyResponse.json()
  assert.equal(body.messages['20'].text, '')
  assert.equal(body.messages['20'].process.length, 2)
  assert.equal(body.messages['20'].process[0].arguments, '{"cmd":"c1"}')
  assert.equal(body.messages['20'].process[0].result, '结果-c1')
  assert.equal(body.messages['50'].text, '最终回答')
  assert.deepEqual(failures, [])
})
