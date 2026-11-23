import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
const cacheSource = await readFile(new URL('../browser-cache.js', import.meta.url), 'utf8')
const snippet = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)))
const plain = value => JSON.parse(JSON.stringify(value))

function harness(count = 95) {
  const thread = { id: 'a', dshSessionId: 'session-a', messages: Array.from({ length: count }, (_, sourceSeq) => ({ sourceSeq, kind: sourceSeq % 2 ? 'assistant' : 'user', text: '预览' })) }
  const other = { id: 'b', messages: [{ sourceSeq: 1 }] }
  const requests = []
  let renders = 0
  let responder = async path => {
    const params = new URL(path, 'http://local').searchParams
    const seqs = params.get('seqs').split(',').map(Number)
    return { messages: Object.fromEntries(seqs.map(seq => [seq, { text: `正文${seq}` }])), nextCursor: null }
  }
  const context = vm.createContext({
    DETAIL_PAGE_MESSAGES: 40, AbortController,
    document: { hidden: false },
    canvasGraphCache: null,
    state: {
      workspace: { id: 'workspace', threads: [thread, other] }, mode: 'thread', activeId: 'a', mapVisible: true,
      bodyFailures: new Set(),
      detailPageByThread: new Map(), detailTargetCardId: null, detailThreadId: 'a', detailScrollByThread: new Map([['a', 500]]),
      mountedCardIds: new Set(), canvasCardsById: new Map(), inspectorCardId: null, pendingReplies: new Map(),
      expandedMessageIds: new Set(), inspectorScrollByCard: new Map(), historyBySession: new Map(), liveReplies: new Map(),
    },
    messagesFor: value => value.messages,
    currentThread() { return context.state.workspace.threads.find(value => value.id === context.state.activeId) },
    canReplaceView: () => true, deferCanvasRefresh() {}, cancelCanvasZoom() {}, resetCanvasInteraction() {},
    api: async path => { requests.push(path); return responder(path) },
    render() { renders += 1 },
    renderCanvas: () => '', questionFor: () => '会话标题', escapeHtml: value => value,
    threadMessage: (_, message) => `<article data-seq="${message.sourceSeq}"></article>`,
    markdownCache: { clear() {} }, connectorPathsByCard: new Map(),
    visibleThreads: threads => threads,
  })
  vm.runInContext([
    cacheSource,
    snippet('const bodyCache =', 'function rememberBranchAnchor('),
    snippet('function setCanvasFocus(', 'function focusActiveCard('),
    snippet('function detailPage(', 'function render() {'),
    snippet('function hydrateBodies()', 'function renderPreservingDetailScroll'),
    snippet('function bodyNotice(', 'function threadMessage('),
  ].join('\n'), context)
  const loader = vm.runInContext('bodyLoader', context)
  return { context, state: context.state, thread, requests, cache: vm.runInContext('bodyCache', context),
    loader, hydrate: async () => { context.hydrateBodies(); await loader.idle() },
    setResponder(fn) { responder = fn }, renders: () => renders }
}

test('detail defaults to the latest page and old card targets select and render their own page', () => {
  const h = harness()
  const page = h.context.detailPage(h.thread)
  assert.equal(page.start, 80)
  assert.equal(page.messages.length, 15)
  h.state.detailTargetCardId = 'a:turn:22'
  const targeted = h.context.detailPage(h.thread)
  assert.equal(targeted.start, 0)
  assert.equal(targeted.messages.length, 40)
  const html = h.context.renderThread()
  assert.equal((html.match(/<article /g) ?? []).length, 40)
  assert.match(html, /detail-prev/)
  assert.match(html, /detail-next/)
  assert.match(html, /data-seq="22"/)
  assert.doesNotMatch(html, /data-seq="80"/)
})

test('navigation resets scroll and hydrates just the visible page in bounded batches', async () => {
  const h = harness()
  h.context.changeDetailPage(h.thread, -1)
  assert.equal(h.state.detailPageByThread.get('a'), 40)
  assert.equal(h.state.detailScrollByThread.get('a'), 0)
  await h.hydrate()
  assert.equal(h.requests.length, 2)
  assert.deepEqual([...h.cache.lru.entries.keys()].map(key => Number(key.split(':')[1])).sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i + 40))
  for (const path of h.requests) assert.ok(new URL(path, 'http://local').searchParams.get('seqs').split(',').length <= 20)
  h.context.changeDetailPage(h.thread, 1)
  assert.equal(h.state.detailPageByThread.get('a'), null)
  await h.hydrate()
  assert.ok(h.cache.get('a', 94, h.context.bodyRevision(h.thread.messages[94])))
})

test('partial pages follow cursors and do not suppress loading later history', async () => {
  const h = harness(42)
  h.setResponder(async path => {
    const params = new URL(path, 'http://local').searchParams
    const seqs = params.get('seqs').split(',').map(Number)
    const cursor = Number(params.get('cursor'))
    return { messages: { [seqs[cursor]]: { text: '正文' } }, nextCursor: cursor + 1 < seqs.length ? cursor + 1 : null }
  })
  await h.hydrate()
  assert.deepEqual([...h.cache.lru.entries.keys()], ['a:40', 'a:41'])
  assert.equal(h.requests.length, 2)
  h.context.changeDetailPage(h.thread, -1)
  await h.hydrate()
  assert.equal(h.cache.size, 42)
  assert.equal(h.loader.jobs.size, 0)
  assert.equal(h.state.bodyFailures.size, 0)
})

test('switching details ignores late unavailable responses and limits failures to the visible page', async () => {
  const h = harness(3)
  let finish
  h.setResponder(() => new Promise(resolve => { finish = resolve }))
  const pending = h.hydrate()
  const finishOld = finish
  h.state.activeId = 'b'
  const next = h.hydrate()
  finish({ unavailable: true, messages: { 0: { text: '预览', previewOnly: true } }, nextCursor: null })
  await next
  finishOld({ unavailable: true, messages: { 0: { text: '旧正文' } }, nextCursor: null })
  await pending
  assert.equal(h.state.bodyFailures.has('a:1'), false)
  assert.equal(h.state.bodyFailures.has('b:1'), true)
  assert.equal(h.state.bodyFailures.has('a:2'), false)
  h.setResponder(async () => { throw new Error('offline') })
  h.state.activeId = 'a'
  await h.hydrate()
  assert.equal(h.state.bodyFailures.has('a:0'), true)
  assert.equal(h.state.bodyFailures.has('a:2'), true)
  assert.equal(h.loader.jobs.size, 0)
})

test('body request single-flight keys prevent duplicate hydration during a pending page', async () => {
  const h = harness(3)
  let finish
  h.setResponder(() => new Promise(resolve => { finish = resolve }))
  const pending = h.hydrate()
  const duplicate = h.hydrate()
  assert.equal(h.requests.length, 1)
  finish({ messages: { 0: { text: '正文' }, 1: { text: '正文' }, 2: { text: '正文' } }, nextCursor: null })
  await pending
  await duplicate
  assert.equal(h.loader.jobs.size, 0)
})

test('previews show loading or retry while truncated content points to DSH', async () => {
  const h = harness()
  const preview = { ...h.thread.messages[80], previewOnly: true }
  assert.match(h.context.bodyNotice(h.thread, preview), /正在加载正文/)
  for (const message of [{ hydrated: true, truncated: true }, { processTruncated: true }]) {
    assert.match(h.context.bodyNotice(h.thread, message), /DSH/)
  }
  assert.equal(h.context.bodyNotice(h.thread, { sourceSeq: 0, hydrated: true }), '')
  h.setResponder(async () => ({ messages: {}, nextCursor: null }))
  await h.hydrate()
  assert.match(h.context.bodyNotice(h.thread, preview), /data-action="retry-bodies"/)
  const page = h.context.detailPage(h.thread)
  assert.deepEqual(plain(page.messages.map(message => message.sourceSeq)), Array.from({ length: 15 }, (_, i) => 80 + i))
})

test('folded tools do not read their payloads and inspector collection stops at twelve entries', () => {
  const context = vm.createContext({
    state: { expandedMessageIds: new Set() }, escapeHtml: value => value,
    processState: () => 'done', processSummary: () => '记录',
  })
  vm.runInContext([
    snippet('function processRecords(', 'function messagesForCard('),
    snippet('function inspectorProcessEntries(', 'function renderCardInspector('),
  ].join('\n'), context)
  const entry = { name: 'shell', status: 'done' }
  Object.defineProperty(entry, 'arguments', { get() { throw new Error('folded payload was read') } })
  assert.doesNotThrow(() => context.processRecords([entry], 'message'))
  const extra = {}
  Object.defineProperty(extra, 'process', { get() { throw new Error('records beyond the limit were read') } })
  const entries = context.inspectorProcessEntries([{ process: Array.from({ length: 20 }, () => ({ name: 'tool' })) }, extra])
  assert.equal(entries.length, 12)
})

test('retained graph cards keep previews when bodies are hydrated and then evicted', () => {
  const h = harness(2)
  h.context.persistedMessagesFor = thread => thread.messages
  h.context.layoutConversationGraph = cards => cards
  h.state.branchAnchors = new Map()
  h.state.cardPositions = new Map()
  vm.runInContext([
    snippet('function messagesFor(', 'function latestMessage('),
    snippet('function conversationCards(', 'function conversationGraphView('),
  ].join('\n'), h.context)
  const projected = h.thread.messages[1]
  h.cache.set('a', projected.sourceSeq, h.context.bodyRevision(projected), { text: '全文'.repeat(2000), process: [], truncated: false })
  const [card] = h.context.conversationCards([h.thread])
  assert.equal(card.answer.text, '预览')
  assert.equal(h.context.hydratedCard(card).answer.text.length, 4000)
  h.cache.clear()
  assert.equal(card.answer.text, '预览')
  assert.equal(card.answer.hydrated, undefined)
  assert.equal(h.context.hydratedCard(card).answer.text, '预览')
})
