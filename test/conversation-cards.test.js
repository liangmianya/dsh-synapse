import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function loadConversationCards() {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const start = source.indexOf('function overlapsCard')
  const end = source.indexOf('function canvasConnectors')
  const context = { globalThis: {}, CARD_WIDTH: 310, CARD_HEIGHT: 276, CARD_GAP_Y: 42, CAMERA_INSET_X: 56, CAMERA_INSET_Y: 56, messagesFor: thread => thread.messages, state: { branchAnchors: new Map(), cardPositions: new Map(), liveReplies: new Map(), collapsedCardIds: new Set() } }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)};globalThis.conversationCards = conversationCards;globalThis.conversationGraphView = conversationGraphView;globalThis.initialCanvasCamera = initialCanvasCamera`, context)
  return { conversationCards: context.globalThis.conversationCards, conversationGraphView: context.globalThis.conversationGraphView, initialCanvasCamera: context.globalThis.initialCanvasCamera, state: context.state }
}

test('projects each user question in one DSH session as a connected canvas card', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([{
    id: 'session-1', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '第一个问题', sourceSeq: 1 },
      { kind: 'assistant', text: '第一个回答草稿', sourceSeq: 2 },
      { kind: 'assistant', text: '第一个最终回答', sourceSeq: 3 },
      { kind: 'user', text: '第二个问题', sourceSeq: 4 },
      { kind: 'assistant', text: '第二个最终回答', sourceSeq: 5 },
    ],
  }])

  assert.equal(cards.length, 2)
  assert.equal(cards[0].question, '第一个问题')
  assert.equal(cards[0].answer.text, '第一个最终回答')
  assert.equal(cards[1].question, '第二个问题')
  assert.equal(cards[1].parentId, cards[0].id)
  assert.equal(cards[1].position.x, cards[0].position.x + 365)
  assert.equal(cards[0].canContinue, undefined)
  assert.equal(cards[1].canContinue, true)
})

test('keeps the prose answer when the turn ends on a tool-only step', async () => {
  const { conversationCards } = await loadConversationCards()
  const [card] = conversationCards([{
    id: 'session-tools', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '列一下目录', sourceSeq: 1 },
      { kind: 'assistant', text: '我先看看目录里有什么。', sourceSeq: 2, process: [{ callId: 'call-1', name: 'pwsh', status: 'done' }] },
      { kind: 'assistant', text: '', sourceSeq: 3, process: [{ callId: 'call-2', name: 'glob', status: 'done' }] },
    ],
  }])

  // The tool-only step still counts towards `工具 N`, but the card body stays the
  // last step that actually wrote prose instead of `glob {"pattern":…}`.
  assert.equal(card.answer.text, '我先看看目录里有什么。')
  assert.equal(card.processCount, 2)
})

test('keeps a failed turn visible when Harness produces no assistant message', async () => {
  const { conversationCards } = await loadConversationCards()
  const [card] = conversationCards([{
    id: 'session-error', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '调用搜索', sourceSeq: 1 },
      { kind: 'error', text: 'QuotaExceeded: INSUFFICIENT_BALANCE: 余额不足', sourceSeq: 2 },
    ],
  }])

  assert.equal(card.answer, null)
  assert.equal(card.error.text, 'QuotaExceeded: INSUFFICIENT_BALANCE: 余额不足')
  assert.equal(card.canContinue, true)
})

test('connects a restored fork to its DSH seed boundary, not its canvas position', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    {
      id: 'parent', parentId: null, position: { x: 86, y: 82 },
      messages: [
        { kind: 'user', text: '第一轮', sourceSeq: 1 },
        { kind: 'assistant', text: '第一轮回答', sourceSeq: 2 },
        { kind: 'user', text: '第二轮', sourceSeq: 5 },
        { kind: 'assistant', text: '第二轮回答', sourceSeq: 6 },
        { kind: 'user', text: '第三轮', sourceSeq: 9 },
        { kind: 'assistant', text: '第三轮回答', sourceSeq: 10 },
      ],
    },
    {
      id: 'child', parentId: 'parent', sourceSeedLength: 8, position: { x: 9999, y: -9999 },
      messages: [
        { kind: 'user', text: '分支问题', sourceSeq: 9 },
        { kind: 'assistant', text: '分支回答', sourceSeq: 10 },
      ],
    },
  ])

  const parentTurns = cards.filter(card => card.dshThreadId === 'parent')
  const childTurn = cards.find(card => card.dshThreadId === 'child')
  assert.equal(childTurn.parentId, parentTurns[1].id)
})

test('uses a restored child message sequence to reconnect a legacy fork at its user turn', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    {
      id: 'parent', parentId: null, position: { x: 86, y: 82 },
      messages: [
        { kind: 'user', text: '你好', sourceSeq: 7 },
        { kind: 'assistant', text: '你好，我是助手。', sourceSeq: 111 },
        { kind: 'user', text: '你是谁', sourceSeq: 118 },
        { kind: 'assistant', text: '我是 DSH。', sourceSeq: 278 },
      ],
    },
    {
      id: 'child', parentId: 'parent', sourceSeedLength: null, position: { x: 1200, y: 900 },
      messages: [
        { kind: 'user', text: '代码是什么', sourceSeq: 121 },
        { kind: 'assistant', text: '代码是指令。', sourceSeq: 569 },
      ],
    },
  ])

  const parentTurns = cards.filter(card => card.dshThreadId === 'parent')
  const childTurn = cards.find(card => card.dshThreadId === 'child')
  assert.equal(childTurn.parentId, parentTurns[1].id)
})

test('places a fork beside the exact parent turn while avoiding overlap', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    {
      id: 'parent', parentId: null, position: { x: 86, y: 82 },
      messages: [
        { kind: 'user', text: '第一轮', sourceSeq: 1 },
        { kind: 'assistant', text: '第一轮回答', sourceSeq: 2 },
        { kind: 'user', text: '第二轮', sourceSeq: 5 },
        { kind: 'assistant', text: '第二轮回答', sourceSeq: 6 },
        { kind: 'user', text: '第三轮', sourceSeq: 9 },
        { kind: 'assistant', text: '第三轮回答', sourceSeq: 10 },
      ],
    },
    {
      id: 'child', parentId: 'parent', sourceSeedLength: 8, position: { x: 86, y: 900 },
      messages: [
        { kind: 'user', text: '第二轮分支', sourceSeq: 9 },
        { kind: 'assistant', text: '分支回答', sourceSeq: 10 },
      ],
    },
  ])

  const parentTurns = cards.filter(card => card.dshThreadId === 'parent')
  const childTurn = cards.find(card => card.dshThreadId === 'child')
  assert.equal(childTurn.parentId, parentTurns[1].id)
  assert.equal(childTurn.position.x, parentTurns[1].position.x + 365)
  assert.ok(childTurn.position.y > parentTurns[1].position.y)
})

test('keeps every turn of one branch on the same horizontal lane', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    {
      id: 'parent', parentId: null, position: { x: 86, y: 82 },
      messages: [
        { kind: 'user', text: '第一轮', sourceSeq: 1 },
        { kind: 'assistant', text: '第一轮回答', sourceSeq: 2 },
        { kind: 'user', text: '第二轮', sourceSeq: 5 },
        { kind: 'assistant', text: '第二轮回答', sourceSeq: 6 },
      ],
    },
    {
      id: 'child', parentId: 'parent', sourceSeedLength: 7, position: { x: 999, y: 999 },
      messages: [
        { kind: 'user', text: '分支第一轮', sourceSeq: 7 },
        { kind: 'assistant', text: '分支第一轮回答', sourceSeq: 8 },
        { kind: 'user', text: '分支第二轮', sourceSeq: 9 },
        { kind: 'assistant', text: '分支第二轮回答', sourceSeq: 10 },
        { kind: 'user', text: '分支第三轮', sourceSeq: 11 },
        { kind: 'assistant', text: '分支第三轮回答', sourceSeq: 12 },
      ],
    },
  ])

  const childTurns = cards.filter(card => card.dshThreadId === 'child')
  assert.equal(new Set(childTurns.map(card => card.position.y)).size, 1)
  assert.equal(childTurns[1].position.x, childTurns[0].position.x + 365)
  assert.equal(childTurns[2].position.x, childTurns[1].position.x + 365)
})

test('moves automatically placed cards below an occupied card instead of overlapping it', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    { id: 'first', parentId: null, position: { x: 86, y: 82 }, messages: [{ kind: 'user', text: '第一条', sourceSeq: 1 }] },
    { id: 'second', parentId: null, position: { x: 86, y: 220 }, messages: [{ kind: 'user', text: '第二条', sourceSeq: 1 }] },
  ])

  assert.equal(cards[0].position.y, 82)
  assert.ok(cards[1].position.y >= 400)
})

test('honors an in-memory dragged card position even far from the natural layout', async () => {
  const { conversationCards, state } = await loadConversationCards()
  state.cardPositions.set('session-1:turn:1', { x: 1280, y: 1280 })
  const cards = conversationCards([{
    id: 'session-1', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '第一个问题', sourceSeq: 1 },
      { kind: 'assistant', text: '第一个回答', sourceSeq: 2 },
    ],
  }])

  assert.equal(cards[0].position.x, 1280)
  assert.equal(cards[0].position.y, 1280)
})

test('does not move later turns when an earlier card is dragged', async () => {
  const { conversationCards, state } = await loadConversationCards()
  state.cardPositions.set('session-1:turn:1', { x: 1280, y: 1280 })
  const cards = conversationCards([{
    id: 'session-1', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '第一个问题', sourceSeq: 1 },
      { kind: 'assistant', text: '第一个回答', sourceSeq: 2 },
      { kind: 'user', text: '第二个问题', sourceSeq: 3 },
      { kind: 'assistant', text: '第二个回答', sourceSeq: 4 },
    ],
  }])

  assert.equal(cards[0].position.x, 1280)
  assert.equal(cards[1].position.x, 451)
  assert.equal(cards[1].position.y, 82)
})

test('keeps a dragged pending turn position after DSH assigns a source sequence', async () => {
  const { conversationCards, state } = await loadConversationCards()
  state.cardPositions.set('session-1:turn-index:0', { x: 740, y: 360 })
  const cards = conversationCards([{
    id: 'session-1', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '第一个问题', sourceSeq: 21 },
      { kind: 'assistant', text: '第一个回答', sourceSeq: 22 },
    ],
  }])

  assert.equal(cards[0].position.x, 740)
  assert.equal(cards[0].position.y, 360)
})

test('derives root card positions from the visible graph instead of stale persisted thread pixels', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    { id: 'dirty-root', parentId: null, position: { x: 86, y: 3200 }, messages: [{ kind: 'user', text: '脏坐标会话', sourceSeq: 1 }] },
  ])

  assert.equal(cards[0].position.x, 86)
  assert.equal(cards[0].position.y, 82)
})

test('focuses a new-session draft before existing cards when initializing the canvas', async () => {
  const { initialCanvasCamera, state } = await loadConversationCards()
  state.draft = { kind: 'new', text: '', sending: false }
  state.zoom = 1
  const camera = initialCanvasCamera([{ id: 'old-card', position: { x: 86, y: 1600 } }])

  assert.equal(camera.x, -30)
  assert.equal(camera.y, -26)
})

test('collapsing a conversation card hides its complete linear descendant chain', async () => {
  const { conversationCards, conversationGraphView } = await loadConversationCards()
  const cards = conversationCards([{
    id: 'session-1', parentId: null,
    messages: [
      { kind: 'user', text: '第一轮', sourceSeq: 1 },
      { kind: 'assistant', text: '回答一', sourceSeq: 2 },
      { kind: 'user', text: '第二轮', sourceSeq: 3 },
      { kind: 'assistant', text: '回答二', sourceSeq: 4 },
      { kind: 'user', text: '第三轮', sourceSeq: 5 },
      { kind: 'assistant', text: '回答三', sourceSeq: 6 },
    ],
  }])

  const graph = conversationGraphView(cards, new Set([cards[0].id]))
  assert.deepEqual(Array.from(graph.cards, card => card.id), [cards[0].id])
  assert.equal(graph.childCounts.get(cards[0].id), 1)
  assert.equal(graph.descendantCounts.get(cards[0].id), 2)
})

test('collapsing a fork point hides all branch descendants without hiding another root', async () => {
  const { conversationCards, conversationGraphView } = await loadConversationCards()
  const cards = conversationCards([
    {
      id: 'parent', parentId: null,
      messages: [
        { kind: 'user', text: '父问题', sourceSeq: 1 },
        { kind: 'assistant', text: '父回答', sourceSeq: 2 },
        { kind: 'user', text: '父追问', sourceSeq: 5 },
        { kind: 'assistant', text: '父追问回答', sourceSeq: 6 },
      ],
    },
    {
      id: 'child', parentId: 'parent', sourceSeedLength: 4,
      messages: [
        { kind: 'user', text: '分支问题', sourceSeq: 4 },
        { kind: 'assistant', text: '分支回答', sourceSeq: 5 },
        { kind: 'user', text: '分支追问', sourceSeq: 6 },
      ],
    },
    { id: 'other-root', parentId: null, messages: [{ kind: 'user', text: '独立会话', sourceSeq: 1 }] },
  ])
  const forkPoint = cards.find(card => card.dshThreadId === 'parent' && card.turnIndex === 0)
  const graph = conversationGraphView(cards, new Set([forkPoint.id]))

  assert.deepEqual(Array.from(graph.cards, card => card.question).sort(), ['父问题', '独立会话'].sort())
  assert.equal(graph.childCounts.get(forkPoint.id), 2)
  assert.equal(graph.descendantCounts.get(forkPoint.id), 3)
})

test('expanding a card restores descendants at their original coordinates', async () => {
  const { conversationCards, conversationGraphView } = await loadConversationCards()
  const cards = conversationCards([{
    id: 'session-1', parentId: null,
    messages: [
      { kind: 'user', text: '第一轮', sourceSeq: 1 },
      { kind: 'assistant', text: '回答一', sourceSeq: 2 },
      { kind: 'user', text: '第二轮', sourceSeq: 3 },
    ],
  }])
  const originalPositions = cards.map(card => ({ ...card.position }))

  assert.equal(conversationGraphView(cards, new Set([cards[0].id])).cards.length, 1)
  const expanded = conversationGraphView(cards, new Set()).cards
  assert.equal(expanded.length, 2)
  assert.deepEqual(expanded.map(card => ({ ...card.position })), originalPositions)
})

test('a new descendant remains hidden while its ancestor is collapsed', async () => {
  const { conversationCards, conversationGraphView } = await loadConversationCards()
  const initialCards = conversationCards([{
    id: 'session-1', parentId: null,
    messages: [
      { kind: 'user', text: '第一轮', sourceSeq: 1 },
      { kind: 'assistant', text: '回答一', sourceSeq: 2 },
      { kind: 'user', text: '第二轮', sourceSeq: 3 },
    ],
  }])
  const collapsedId = initialCards[0].id
  const updatedCards = conversationCards([{
    id: 'session-1', parentId: null,
    messages: [
      { kind: 'user', text: '第一轮', sourceSeq: 1 },
      { kind: 'assistant', text: '回答一', sourceSeq: 2 },
      { kind: 'user', text: '第二轮', sourceSeq: 3 },
      { kind: 'assistant', text: '回答二', sourceSeq: 4 },
      { kind: 'user', text: '后来新增的第三轮', sourceSeq: 5 },
    ],
  }])

  const graph = conversationGraphView(updatedCards, new Set([collapsedId]))
  assert.deepEqual(Array.from(graph.cards, card => card.question), ['第一轮'])
  assert.equal(graph.descendantCounts.get(collapsedId), 2)
})

test('nested collapsed nodes remain visible when their ancestor is expanded', async () => {
  const { conversationCards, conversationGraphView } = await loadConversationCards()
  const cards = conversationCards([{
    id: 'session-1', parentId: null,
    messages: [
      { kind: 'user', text: '第一轮', sourceSeq: 1 },
      { kind: 'assistant', text: '回答一', sourceSeq: 2 },
      { kind: 'user', text: '第二轮', sourceSeq: 3 },
      { kind: 'assistant', text: '回答二', sourceSeq: 4 },
      { kind: 'user', text: '第三轮', sourceSeq: 5 },
    ],
  }])

  const nested = conversationGraphView(cards, new Set([cards[0].id, cards[1].id]))
  assert.deepEqual(Array.from(nested.cards, card => card.question), ['第一轮', '第二轮'])
  const childOnly = conversationGraphView(cards, new Set([cards[1].id]))
  assert.deepEqual(Array.from(childOnly.cards, card => card.question), ['第一轮', '第二轮'])
})

test('cyclic collapsed roots stay visible and count unique descendants', async () => {
  const { conversationGraphView } = await loadConversationCards()
  const cards = [
    { id: 'a', parentId: 'b', dshThreadId: 'a' },
    { id: 'b', parentId: 'a', dshThreadId: 'b' },
  ]
  const graph = conversationGraphView(cards, new Set(['a', 'b']))

  assert.deepEqual(Array.from(graph.cards, card => card.id), ['a', 'b'])
  assert.equal(graph.descendantCounts.get('a'), 1)
  assert.equal(graph.descendantCounts.get('b'), 1)
})

async function loadProcessRecords() {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const start = source.indexOf('function processState')
  const end = source.indexOf('function messagesForCard')
  const context = {
    globalThis: {},
    state: { expandedMessageIds: new Set(['m:process']) },
    escapeHtml: value => String(value).replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]),
  }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)};globalThis.processRecords = processRecords`, context)
  return context.globalThis.processRecords
}

test('renders a stored process entry by its status instead of failing every tool', async () => {
  const processRecords = await loadProcessRecords()

  const html = processRecords([
    { name: 'pws', status: 'done' },
    { name: 'read', status: 'pending' },
    { name: 'edit', status: 'failed' },
  ], 'm')

  assert.match(html, /pws<\/span><span class="process-status process-status-done">完成/)
  assert.match(html, /read<\/span><span class="process-status process-status-pending">等待结果/)
  assert.match(html, /edit<\/span><span class="process-status process-status-error">失败/)
  assert.doesNotMatch(html, /undefined/)
})

test('still reads a v3-era process entry that only carries error and result', async () => {
  const processRecords = await loadProcessRecords()

  const html = processRecords([
    { name: 'a', arguments: 'x', result: 'ok', error: null },
    { name: 'b', result: null, error: 'boom' },
    { name: 'c', result: null, error: null },
  ], 'm')

  assert.match(html, /a<\/span><span class="process-status process-status-done">完成/)
  assert.match(html, /b<\/span><span class="process-status process-status-error">失败/)
  assert.match(html, /c<\/span><span class="process-status process-status-pending">等待结果/)
})
