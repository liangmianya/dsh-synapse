import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
const cacheSource = await readFile(new URL('../browser-cache.js', import.meta.url), 'utf8')
const snippet = (from, to) => {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + from.length)
  assert.ok(start >= 0 && end > start, `missing source boundary: ${from}`)
  return source.slice(start, end)
}
const plain = value => JSON.parse(JSON.stringify(value))
const thread = (id, parentId = null, count = 2) => ({
  id, parentId, dshSessionId: `session-${id}`, title: id, sourceSeedLength: 3,
  messages: Array.from({ length: count * 2 }, (_, index) => ({
    kind: index % 2 ? 'assistant' : 'user', sourceSeq: index + 1, text: `${id}-${index}`,
  })),
})

// Only the host and DOM shell are doubled: the graph, focus transitions,
// camera arithmetic, click handler and host navigation handler are real.
class Element {
  constructor(dataset = {}) { this.dataset = dataset }
  closest(selector) {
    if (selector === '[data-action]') return this.dataset.action ? this : null
    if (selector.startsWith('.thread-card')) return this.dataset.cardId ? this : null
    return null
  }
}
class HTMLElement extends Element {}

function harness(threads = [thread('other'), thread('root'), thread('child', 'root'), thread('grandchild', 'child'), thread('sibling', 'root')]) {
  const appListeners = new Map()
  const hostListeners = new Map()
  const frames = []
  const posts = []
  const bodyRequests = []
  const viewport = new HTMLElement()
  viewport.getBoundingClientRect = () => ({ width: 1000, height: 700, left: 0, top: 0 })
  let rendered = ''
  const context = vm.createContext({
    Element, HTMLElement,
    CARD_WIDTH: 310, CARD_HEIGHT: 276, CARD_GAP_Y: 42, CAMERA_INSET_X: 56, CAMERA_INSET_Y: 56,
    state: {
      workspace: { id: 'workspace-a', threads }, activeId: 'root', selectedCardId: null,
      focusedThreadId: null, canvasFocusRevision: 0,
      currentDsh: { id: 'session-root' }, mode: 'canvas', zoom: .4, canvasCamera: { x: -720, y: 125 },
      canvasViewInitialized: true, canvasNeedsCenter: false, draft: null, error: '',
      inspectorCardId: null, inspectorOpening: false, mapVisible: true,
      branchAnchors: new Map(), cardPositions: new Map(), collapsedCardIds: new Set(),
      liveReplies: new Map(), archivedSessionIds: new Set(), mapCardSessionSwitches: new Set(),
      historyBySession: new Map(), detailScrollByThread: new Map(), detailPageByThread: new Map(),
      inspectorScrollByCard: new Map(), expandedMessageIds: new Set(), mountedCardIds: new Set(),
    },
    document: { hidden: false, querySelector: selector => selector === '.canvas-viewport' ? viewport : null },
    window: {
      location: { origin: 'http://local' },
      addEventListener: (type, listener) => hostListeners.set(type, listener),
      requestAnimationFrame: callback => { frames.push(callback); return frames.length },
      clearTimeout() {}, setTimeout() {},
    },
    app: { addEventListener: (type, listener) => appListeners.set(type, listener) },
    messagesFor: value => value.messages,
    escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    threadListTitle: value => value.title,
    renderCardInspector: card => `<aside>${card.question}</aside>`,
    bodyLoader: { pause() {}, retainThreads() {}, sync: (wanted, key) => bodyRequests.push({ wanted, key }) },
    bodyRevision: () => 'revision',
    markdownCache: { clear() {} },
    applyCanvasTransform() {}, syncCanvasViewport() {}, clearViewCaches() {},
    canReplaceView: () => true,
    currentDshThread() { return context.state.workspace.threads.find(value => value.dshSessionId === context.state.currentDsh?.id) },
    openCurrentWorkspace: async () => false,
    loadThreadHistory: async () => {},
    post: (type, payload) => posts.push({ type, ...payload }),
    setError: error => { context.state.error = String(error) },
    openCardInspector: id => { context.state.inspectorCardId = id },
    persistCollapsedCards: () => context.invalidateCanvasGraph(),
    persistCardPositions() {},
    localStorage: { setItem() {} },
    pointerDownPosition: null,
    render() {
      rendered = context.renderCanvas()
      context.finishCanvasRender()
    },
  })
  vm.runInContext([
    cacheSource,
    snippet('function resetCanvasCamera(', 'async function api('),
    snippet('function visibleThreads(', 'function persistedMessagesFor('),
    snippet('function sessionSignature(', 'function workspaceChoices('),
    snippet('function overlapsCard(', 'function canvasConnectors('),
    snippet('function draftPlacement(', 'function draftCard('),
    snippet('let canvasGraphRevision =', 'function canvasWorldBounds('),
    snippet('function canvasScopeControls(', 'function isProcessMessage('),
    snippet('function setCanvasFocus(', 'let selectionFollowup ='),
    snippet('function pruneWorkspaceCaches(', 'function pauseMapBodies('),
    snippet('function hydrateBodies()', 'function refreshLoadedBodies('),
    snippet("app.addEventListener('click', async event =>", "app.addEventListener('change', event =>"),
    snippet("window.addEventListener('message', event =>", "post('synapse:request-current')"),
    `let cacheWorkspaceId = 'workspace-a'; let cacheThreadIds = new Set(state.workspace.threads.map(thread => thread.id));`,
    `function finishCanvasRender() { ${snippet('  if (state.canvasNeedsCenter) {', '  for (const [cardId, scrollTop]')} }`,
  ].join('\n'), context)
  context.render()
  return {
    context, state: context.state, posts, bodyRequests, viewport,
    get html() { return rendered },
    render: () => context.render(),
    drainFrames() { while (frames.length) frames.shift()() },
    click: (action, fields = {}) => appListeners.get('click')({ target: new HTMLElement({ action, ...fields }), detail: 1 }),
    clickCard: card => appListeners.get('click')({ target: new HTMLElement({ thread: card.dshThreadId, cardId: card.id }), detail: 1 }),
    async navigate(sessionId, fields = {}) {
      hostListeners.get('message')({ origin: 'http://local', data: { source: 'dsh-synapse', type: 'synapse:current-session', session: { id: sessionId, ...fields } } })
      await Promise.resolve()
    },
  }
}
const ids = h => Array.from(h.state.canvasCards, card => card.dshThreadId)
const indexCards = h => Array.from(vm.runInContext('canvasGraphCache.index.query({ left: -10000, right: 10000, top: -10000, bottom: 10000 })', h.context))

test('focus includes every turn and nested forks without moving cards or filtering the sidebar list', async () => {
  const h = harness()
  const positions = new Map(h.state.canvasCards.map(card => [card.id, plain(card.position)]))
  await h.click('focus-thread')
  assert.deepEqual([...new Set(ids(h))].sort(), ['root', 'child', 'grandchild', 'sibling'].sort())
  assert.equal(h.state.canvasCards.length, 8)
  assert.equal(h.context.visibleThreads(h.state.workspace.threads).length, 5)
  for (const card of h.state.canvasCards) assert.deepEqual(plain(card.position), positions.get(card.id))
  assert.ok(indexCards(h).every(card => card.dshThreadId !== 'other'))
  assert.doesNotMatch(h.html, /聚焦：other/)
  assert.match(h.html, /聚焦：root/)
})

test('scope follows lineage through empty sessions and ignores missing parents and cycles safely', () => {
  const h = harness([thread('root'), thread('empty', 'root', 0), thread('leaf', 'empty'), thread('orphan', 'missing')])
  h.context.setCanvasFocus('root')
  h.render()
  assert.deepEqual([...new Set(ids(h))].sort(), ['root', 'leaf'].sort())
  const scope = h.context.conversationThreadScope([thread('a', 'b'), thread('b', 'a'), thread('c', 'b')], 'a')
  assert.deepEqual([...scope].sort(), ['a', 'b', 'c'])
  assert.equal(h.context.conversationThreadScope(h.state.workspace.threads, 'missing').size, 0)
})

test('selecting a child focuses its descendants and preserves collapse preferences outside the scope', async () => {
  const h = harness()
  h.state.collapsedCardIds.add('root:turn:1')
  const before = [...h.state.collapsedCardIds]
  await h.click('focus-thread')
  await h.click('select-thread', { thread: 'child' })
  h.drainFrames()
  assert.equal(h.state.focusedThreadId, 'child')
  assert.deepEqual([...new Set(ids(h))].sort(), ['child', 'grandchild'].sort())
  assert.deepEqual([...h.state.collapsedCardIds], before)
  const latest = h.state.canvasCards.filter(card => card.dshThreadId === 'child').at(-1)
  assert.equal(h.state.canvasCamera.x, 500 - (latest.position.x + 155) * h.state.zoom)
  assert.equal(h.state.canvasCamera.y, 350 - (latest.position.y + 138) * h.state.zoom)
  const scopeControls = h.context.canvasScopeControls(h.context.visibleThreads(h.state.workspace.threads))
  assert.match(scopeControls, /data-action="focus-thread" aria-pressed="true"/)
})

test('canvas branch clicks activate DSH and open the inspector while keeping the focus root and camera', async () => {
  const h = harness()
  await h.click('focus-thread')
  h.drainFrames()
  const camera = plain(h.state.canvasCamera)
  const card = h.state.canvasCards.find(card => card.dshThreadId === 'child')
  await h.clickCard(card)
  assert.equal(h.state.activeId, 'child')
  assert.equal(h.state.inspectorCardId, card.id)
  assert.equal(h.state.focusedThreadId, 'root')
  assert.deepEqual(h.posts.at(-1), { type: 'synapse:activate-session', sessionId: 'session-child' })
  await h.navigate('session-child')
  assert.equal(h.state.focusedThreadId, 'root')
  assert.equal(h.state.selectedCardId, card.id)
  assert.deepEqual(plain(h.state.canvasCamera), camera)
  await h.click('focus-thread')
  assert.equal(h.state.focusedThreadId, 'root')
})

test('folding within focus keeps card positions and camera and preserves the fold after exiting', async () => {
  const h = harness()
  await h.click('focus-thread')
  h.drainFrames()
  const camera = plain(h.state.canvasCamera)
  const positions = new Map(h.state.canvasCards.map(card => [card.id, plain(card.position)]))
  await h.click('toggle-card-children', { card: 'child:turn:1' })
  assert.ok(h.state.canvasCards.some(card => card.id === 'child:turn:1'))
  assert.ok(!ids(h).includes('grandchild'))
  assert.ok(!h.state.canvasCards.some(card => card.id === 'child:turn:3'))
  assert.deepEqual(plain(h.state.canvasCamera), camera)
  for (const card of h.state.canvasCards) assert.deepEqual(plain(card.position), positions.get(card.id))
  await h.click('show-workspace')
  assert.ok(h.state.collapsedCardIds.has('child:turn:1'))
  assert.ok(!ids(h).includes('grandchild'))
  assert.ok(ids(h).includes('other'))
})

test('folding a parent hides a child that is already folded, then expanding each restores its own subtree', async () => {
  const h = harness()
  await h.click('focus-thread')
  const camera = plain(h.state.canvasCamera)
  const zoom = h.state.zoom
  const original = h.state.canvasCards.map(card => ({ id: card.id, position: plain(card.position) }))
  await h.click('toggle-card-children', { card: 'child:turn:1' })
  assert.ok(h.state.collapsedCardIds.has('child:turn:1'))
  await h.click('toggle-card-children', { card: 'root:turn:1' })
  assert.deepEqual(Array.from(h.state.canvasCards, card => card.id), ['root:turn:1'])
  assert.ok(h.state.collapsedCardIds.has('child:turn:1'))
  assert.ok(h.state.collapsedCardIds.has('root:turn:1'))
  await h.click('toggle-card-children', { card: 'root:turn:1' })
  assert.ok(!h.state.collapsedCardIds.has('root:turn:1'))
  assert.ok(h.state.canvasCards.some(card => card.id === 'child:turn:1'))
  assert.ok(!h.state.canvasCards.some(card => card.id === 'child:turn:3'))
  assert.ok(!ids(h).includes('grandchild'))
  await h.click('toggle-card-children', { card: 'child:turn:1' })
  assert.deepEqual(h.state.canvasCards.map(card => ({ id: card.id, position: plain(card.position) })), original)
  h.drainFrames()
  assert.deepEqual(plain(h.state.canvasCamera), camera)
  assert.equal(h.state.zoom, zoom)
})

test('entering focus only hides other sessions and keeps the current camera, zoom and positions', async () => {
  const h = harness()
  h.state.cardPositions.set('root:turn:1', { x: -900, y: 1800 })
  h.context.invalidateCanvasGraph()
  h.render()
  const camera = plain(h.state.canvasCamera)
  const zoom = h.state.zoom
  const positions = new Map(h.state.canvasCards.map(card => [card.id, plain(card.position)]))
  // A centering callback queued before the scope switch must not move it.
  h.context.queueActiveCardFocus()
  await h.click('focus-thread')
  h.drainFrames()
  assert.deepEqual(plain(h.state.canvasCamera), camera)
  assert.equal(h.state.zoom, zoom)
  assert.equal(h.state.canvasViewInitialized, true)
  assert.ok(!ids(h).includes('other'))
  for (const card of h.state.canvasCards) assert.deepEqual(plain(card.position), positions.get(card.id))
})

test('exiting focus keeps its latest camera and zoom after panning, zooming, changing roots and dragging', async () => {
  const h = harness()
  await h.click('focus-thread')
  await h.click('select-thread', { thread: 'child' })
  h.state.cardPositions.set('child:turn:1', { x: 2400, y: 1800 })
  h.context.invalidateCanvasGraph()
  h.state.canvasCamera = { x: 12, y: -1200 }
  h.state.zoom = 2.5
  const camera = plain(h.state.canvasCamera)
  const zoom = h.state.zoom
  await h.click('show-workspace')
  // Delayed centering from sidebar navigation must not move the current view.
  h.drainFrames()
  assert.equal(h.state.focusedThreadId, null)
  assert.deepEqual(plain(h.state.canvasCamera), camera)
  assert.equal(h.state.zoom, zoom)
  assert.deepEqual(plain(h.state.canvasCards.find(card => card.id === 'child:turn:1').position), { x: 2400, y: 1800 })
  assert.ok(ids(h).includes('other'))
  await h.click('focus-thread')
  await h.click('show-workspace')
  h.drainFrames()
  assert.deepEqual(plain(h.state.canvasCamera), camera)
  assert.equal(h.state.zoom, zoom)
})

test('sidebar selection in the all-workspace view centers the selected session latest turn', async () => {
  const h = harness()
  await h.click('select-thread', { thread: 'other' })
  h.drainFrames()
  const latest = h.state.canvasCards.filter(card => card.dshThreadId === 'other').at(-1)
  assert.equal(h.state.canvasCamera.x, 500 - (latest.position.x + 155) * h.state.zoom)
  assert.equal(h.state.canvasCamera.y, 350 - (latest.position.y + 138) * h.state.zoom)
  assert.equal(h.state.focusedThreadId, null)
})

test('external navigation changes focus only when leaving the current tree; status updates do not reframe', async () => {
  const h = harness()
  await h.click('focus-thread')
  h.drainFrames()
  const camera = plain(h.state.canvasCamera)
  await h.navigate('session-root', { running: true, title: '新标题' })
  assert.deepEqual(plain(h.state.canvasCamera), camera)
  assert.equal(h.state.focusedThreadId, 'root')
  await h.navigate('session-child')
  assert.equal(h.state.focusedThreadId, 'root')
  await h.navigate('session-other')
  h.drainFrames()
  assert.equal(h.state.focusedThreadId, 'other')
  assert.deepEqual([...new Set(ids(h))], ['other'])
})

test('workspace refreshes retain focus and newly derived branches, while archive and workspace switches reset it', async () => {
  const h = harness()
  await h.click('focus-thread')
  h.state.workspace = { ...h.state.workspace, threads: [...h.state.workspace.threads, thread('new-fork', 'grandchild')] }
  h.context.pruneWorkspaceCaches()
  h.render()
  assert.equal(h.state.focusedThreadId, 'root')
  assert.ok(ids(h).includes('new-fork'))
  h.state.canvasCamera = { x: -135, y: 420 }
  h.state.zoom = .75
  const camera = plain(h.state.canvasCamera)
  h.state.archivedSessionIds.add('session-root')
  h.context.pruneWorkspaceCaches()
  h.render()
  assert.equal(h.state.focusedThreadId, null)
  assert.deepEqual(plain(h.state.canvasCamera), camera)
  assert.equal(h.state.zoom, .75)
  h.state.activeId = 'child'
  await h.click('focus-thread')
  h.state.workspace = { id: 'workspace-b', threads: [thread('other')] }
  h.context.pruneWorkspaceCaches()
  assert.equal(h.state.focusedThreadId, null)
})

test('focus with no user turns has a recoverable empty state and drafts prevent hiding their source', async () => {
  const h = harness([thread('root', null, 0), thread('other')])
  await h.click('focus-thread')
  assert.equal(h.state.canvasCards.length, 0)
  assert.match(h.html, /还没有可显示的对话/)
  assert.match(h.context.canvasScopeControls(h.state.workspace.threads), /data-action="show-workspace"/)
  h.state.draft = { kind: 'continue', parentId: 'root', text: '未发送' }
  await h.click('select-thread', { thread: 'other' })
  await h.click('show-workspace')
  assert.equal(h.state.focusedThreadId, 'root')
  assert.equal(h.state.draft.text, '未发送')
  assert.match(h.state.error, /请先完成或取消/)
  await h.navigate('session-other')
  assert.equal(h.state.focusedThreadId, 'root')
  assert.equal(h.state.draft.text, '未发送')
})

test('body hydration collects the focused region and prefetch with a separate view key', async () => {
  const h = harness()
  await h.click('focus-thread')
  const graphCards = indexCards(h)
  h.context.regionView = { cards: graphCards.slice(0, 1), prefetch: graphCards.slice(1), overview: false }
  // regionView is lexical in the renderer, so assign it inside the context.
  vm.runInContext('regionView = globalThis.regionView', h.context)
  h.context.hydrateBodies()
  const request = h.bodyRequests.at(-1)
  assert.ok(request.wanted.length > 0)
  assert.ok(request.wanted.every(entry => entry.threadId !== 'other'))
  assert.ok(request.wanted.some(entry => entry.priority === 2))
  assert.equal(request.key, 'canvas:root:')
})
