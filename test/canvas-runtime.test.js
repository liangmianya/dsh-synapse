import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
const snippet = (from, to) => {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + from.length)
  assert.ok(start >= 0 && end > start, `missing source boundary: ${from}`)
  return source.slice(start, end)
}
const escapeHtml = value => String(value).replace(/[&<>"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
})[character])

// Check the rendered behavior, without fixing CSS, SVG paths or which
// rendering function owns a particular update.
test('clamps the canvas zoom to a 20% floor and a 400% ceiling', () => {
  const context = vm.createContext({
    state: { zoom: 1, canvasCamera: { x: 0, y: 0 } },
    applyCanvasTransform() {}, syncCanvasViewport() {},
    document: { querySelector: () => null },
    window: { requestAnimationFrame() {} },
    HTMLElement: class {},
  })
  vm.runInContext(snippet('function syncCanvasZoomLabel(', 'function zoomCanvasAtCenter('), context)
  const viewport = { getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelector: () => null }
  for (const [requested, expected] of [[0.05, 0.2], [9, 4], [0.5, 0.5]]) {
    context.zoomCanvas(viewport, requested, 100, 100)
    assert.equal(context.state.zoom, expected)
  }
})

function zoomHarness({ reducedMotion = false, zoomSpeed = 'standard', wheelBehavior = 'zoom' } = {}) {
  let time = 0
  let nextFrame = 1
  let writes = 0
  let prevented = 0
  const frames = new Map()
  const listeners = new Map()
  class Element {
    closest(selector) { return selector === '.canvas-viewport' ? viewport : null }
  }
  class HTMLElement extends Element {}
  const viewport = new HTMLElement()
  viewport.isConnected = true
  viewport.clientHeight = 800
  viewport.clientWidth = 1000
  viewport.getBoundingClientRect = () => ({ left: 20, top: 40, width: 1000, height: 800 })
  const label = { textContent: '100%' }
  const zoomButton = { querySelector: () => label, setAttribute() {} }
  const context = vm.createContext({
    Element, HTMLElement,
    preferences: { zoomSpeed, wheelBehavior },
    state: { zoom: 1, canvasCamera: { x: -80, y: 30 }, mode: 'canvas', mapVisible: true,
      workspace: { id: 'workspace-a' }, canvasFocusRevision: 0, dragging: false, canvasGesture: false },
    performance: { now: () => time },
    document: { hidden: false, querySelector: selector => selector === '.canvas-viewport' ? viewport : zoomButton },
    window: {
      requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id },
      cancelAnimationFrame: id => frames.delete(id),
      matchMedia: () => ({ matches: reducedMotion }),
    },
    app: { addEventListener: (type, listener) => listeners.set(type, listener) },
    applyCanvasTransform() { writes++ }, syncCanvasViewport() {}, deferCanvasRefresh() {},
  })
  vm.runInContext([
    snippet('const ZOOM_SPEED_FACTORS =', 'function normalizePreferences('),
    snippet('function canvasViewport(', 'function setCanvasFocus('),
    snippet("app.addEventListener('wheel', event =>", '// Track pointer-down'),
  ].join('\n'), context)
  const wheel = (deltaY, fields = {}) => listeners.get('wheel')({
    target: viewport, deltaMode: 0, deltaY, clientX: 220, clientY: 160,
    preventDefault() { prevented++ }, ...fields,
  })
  const step = (ms = 16) => {
    time += ms
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(time)
  }
  const settle = () => {
    for (let count = 0; frames.size > 0 && count < 100; count++) step()
    assert.equal(frames.size, 0, 'zoom animation must settle and release its frame')
  }
  return { context, state: context.state, viewport, label, frames, wheel, step, settle, HTMLElement,
    get writes() { return writes }, get prevented() { return prevented } }
}

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)

test('zoom speed preferences scale wheel distance while preserving the mouse anchor and smoothing', () => {
  const zooms = []
  for (const zoomSpeed of ['slow', 'standard', 'fast']) {
    const h = zoomHarness({ zoomSpeed })
    h.wheel(-100)
    assert.equal(h.writes, 0)
    h.step()
    const interim = h.state.zoom
    h.settle()
    assert.ok(interim > 1 && interim < h.state.zoom)
    near((200 - h.state.canvasCamera.x) / h.state.zoom, 280)
    near((120 - h.state.canvasCamera.y) / h.state.zoom, 90)
    zooms.push(h.state.zoom)
  }
  assert.ok(zooms[0] < zooms[1] && zooms[1] < zooms[2])
  near(Math.log(zooms[0]) / Math.log(zooms[1]), .6)
  near(Math.log(zooms[2]) / Math.log(zooms[1]), 1.6)
})

test('wheel input coalesces into one smooth frame and keeps the point under the mouse fixed', () => {
  const h = zoomHarness()
  for (let index = 0; index < 10; index++) h.wheel(-10)
  assert.equal(h.frames.size, 1)
  assert.equal(h.writes, 0)
  assert.equal(h.state.zoom, 1)
  h.step()
  assert.ok(h.state.zoom > 1)
  const firstZoom = h.state.zoom
  assert.equal(h.writes, 1)
  for (let index = 0; h.frames.size > 0 && index < 100; index++) {
    near((200 - h.state.canvasCamera.x) / h.state.zoom, 280)
    near((120 - h.state.canvasCamera.y) / h.state.zoom, 90)
    h.step()
  }
  assert.equal(h.frames.size, 0)
  assert.ok(h.state.zoom > firstZoom)
  assert.equal(h.label.textContent, `${Math.round(h.state.zoom * 100)}%`)
  const single = zoomHarness()
  single.wheel(-100)
  single.settle()
  near(h.state.zoom, single.state.zoom)
})

test('equivalent pixel, line and page wheel input produces the same zoom', () => {
  const zooms = []
  for (const [deltaY, deltaMode] of [[-16, 0], [-1, 1], [-.02, 2]]) {
    const h = zoomHarness()
    h.wheel(deltaY, { deltaMode })
    h.settle()
    zooms.push(h.state.zoom)
  }
  near(zooms[0], zooms[1])
  near(zooms[0], zooms[2])
})

test('zoom smoothing follows elapsed time consistently at different display rates', () => {
  const slow = zoomHarness()
  const fast = zoomHarness()
  slow.wheel(-120)
  fast.wheel(-120)
  for (let index = 0; index < 10; index++) slow.step(16)
  for (let index = 0; index < 20; index++) fast.step(8)
  near(slow.state.zoom, fast.state.zoom)
  slow.settle()
  fast.settle()
  near(slow.state.zoom, fast.state.zoom)
})

test('moving the mouse and reversing the wheel retargets zoom without an immediate camera jump', () => {
  const h = zoomHarness()
  h.wheel(-100)
  h.step()
  const previous = { zoom: h.state.zoom, ...h.state.canvasCamera }
  const worldX = (380 - previous.x) / previous.zoom
  const worldY = (260 - previous.y) / previous.zoom
  h.wheel(200, { clientX: 400, clientY: 300 })
  assert.equal(h.state.zoom, previous.zoom)
  assert.equal(h.state.canvasCamera.x, previous.x)
  assert.equal(h.state.canvasCamera.y, previous.y)
  h.step()
  assert.ok(h.state.zoom < previous.zoom)
  h.settle()
  near((380 - h.state.canvasCamera.x) / h.state.zoom, worldX)
  near((260 - h.state.canvasCamera.y) / h.state.zoom, worldY)
})

test('zero and invalid wheel input does not zoom; fractional input retains precision', () => {
  const h = zoomHarness()
  for (const delta of [0, NaN, Infinity]) h.wheel(delta)
  assert.equal(h.frames.size, 0)
  assert.equal(h.state.zoom, 1)
  h.wheel(-.1)
  h.settle()
  assert.ok(h.state.zoom > 1 && h.state.zoom < 1.01)
})

test('zoom respects reduced motion and both limits without leaving pending frames', () => {
  for (const reducedMotion of [false, true]) {
    const h = zoomHarness({ reducedMotion })
    for (const [delta, expected] of [[-100_000, 4], [100_000, .2]]) {
      h.wheel(delta)
      if (reducedMotion) assert.equal(h.frames.size, 0)
      h.settle()
      assert.equal(h.state.zoom, expected)
    }
  }
})

test('cancelled, hidden, detached and stale-view zooms cannot move the camera later', () => {
  const cancellations = [
    h => h.context.cancelCanvasZoom(),
    h => { h.context.document.hidden = true },
    h => { h.viewport.isConnected = false },
    h => { h.state.mapVisible = false },
    h => { h.state.mode = 'thread' },
    h => { h.state.workspace.id = 'workspace-b' },
    h => { h.state.canvasFocusRevision++ },
    h => { h.state.dragging = true },
    h => { h.state.canvasGesture = true },
  ]
  for (const cancel of cancellations) {
    const h = zoomHarness()
    h.wheel(-100)
    cancel(h)
    h.step()
    assert.equal(h.state.zoom, 1)
    assert.equal(h.state.canvasCamera.x, -80)
    assert.equal(h.state.canvasCamera.y, 30)
    assert.equal(h.frames.size, 0)
  }
})

test('wheel over a card keeps native answer scrolling and stops any pending canvas zoom', () => {
  for (const scrollable of [false, true]) {
    const h = zoomHarness()
    const card = new h.HTMLElement()
    const answer = Object.assign(new h.HTMLElement(), { scrollHeight: scrollable ? 300 : 100, clientHeight: 100 })
    answer.closest = selector => selector === '.thread-card' ? card : selector === '.canvas-viewport' ? h.viewport : answer
    card.closest = selector => selector === '.thread-card' ? card : h.viewport
    h.wheel(-100)
    const before = h.prevented
    h.wheel(100, { target: answer })
    assert.equal(h.prevented - before, scrollable ? 0 : 1)
    assert.equal(h.frames.size, 0)
    h.step()
    assert.equal(h.state.zoom, 1)
  }
})

test('default wheel pans both axes once per frame and Shift translates vertical-only wheels', () => {
  const h = zoomHarness({ wheelBehavior: 'pan' })
  h.wheel(30, { deltaX: 10 })
  h.wheel(20, { deltaX: 5 })
  assert.equal(h.frames.size, 1)
  assert.equal(h.writes, 0)
  h.step()
  assert.equal(h.state.zoom, 1)
  assert.equal(h.state.canvasCamera.x, -95)
  assert.equal(h.state.canvasCamera.y, -20)
  h.wheel(16, { shiftKey: true })
  h.step()
  assert.equal(h.state.canvasCamera.x, -111)
  assert.equal(h.state.canvasCamera.y, -20)
  // Browsers that emit deltaX for Shift must not translate it a second time.
  h.wheel(0, { shiftKey: true, deltaX: 16 })
  h.step()
  assert.equal(h.state.canvasCamera.x, -127)
})

test('modifier wheel zooms over card bodies and stale pending pans cannot change a new view', () => {
  const h = zoomHarness({ wheelBehavior: 'pan' })
  const card = new h.HTMLElement()
  card.closest = selector => selector === '.thread-card' ? card : h.viewport
  h.wheel(-100, { ctrlKey: true, target: card })
  h.settle()
  assert.ok(h.state.zoom > 1)
  const camera = { ...h.state.canvasCamera }
  h.wheel(100)
  h.state.workspace.id = 'another-workspace'
  h.step()
  assert.deepEqual({ ...h.state.canvasCamera }, camera)
  assert.equal(h.frames.size, 0)
})

function cardHarness() {
  const context = vm.createContext({
    state: { activeId: 'thread-a', selectedCardId: null, collapsedCardIds: new Set() },
    MAP_FACE_TEXT: 4000, escapeHtml,
    hydratedCard: card => card,
    renderMarkdown: text => `<p>${escapeHtml(text)}</p>`,
    connectorPath: () => 'M 0 0 L 1 1',
    draftPlacement: () => null,
  })
  vm.runInContext(snippet('function canvasConnectors(', 'function draftActions('), context)
  return context
}
const card = (id, fields = {}) => ({
  id, positionKey: id, dshThreadId: 'thread-a', parentId: null, turnIndex: 0,
  position: { x: 86, y: 82 }, question: '问题', answer: { text: '回答', sourceSeq: 2 },
  error: null, processCount: 0, ...fields,
})

test('highlights only the selected card while highlighting the current conversation links', () => {
  const h = cardHarness()
  const cards = [
    card('first'),
    card('second', { parentId: 'first', turnIndex: 1 }),
    card('fork', { parentId: 'first', dshThreadId: 'thread-b' }),
  ]
  const graph = { childCounts: new Map() }
  h.state.selectedCardId = 'second'
  assert.doesNotMatch(h.conversationCard(cards[0], graph), /class="thread-card selected/)
  assert.match(h.conversationCard(cards[1], graph), /class="thread-card selected/)
  assert.doesNotMatch(h.conversationCard(cards[2], graph), /class="thread-card selected/)
  const links = h.canvasConnectors(cards)
  assert.match(links, /class="active-connector" data-from="first" data-to="second"/)
  assert.doesNotMatch(links, /class="active-connector" data-from="first" data-to="fork"/)
})

test('offers follow-up on the latest card and folding and branching on earlier answered cards', () => {
  const h = cardHarness()
  const earlier = card('earlier')
  const latest = card('latest', { parentId: 'earlier', turnIndex: 1, canContinue: true })
  const graph = { childCounts: new Map([['earlier', 1]]) }
  const earlierHtml = h.conversationCard(earlier, graph)
  assert.match(earlierHtml, /data-action="toggle-card-children"/)
  assert.match(earlierHtml, /data-action="open-branch"/)
  assert.doesNotMatch(earlierHtml, /data-action="open-continue"/)
  assert.match(earlierHtml, /aria-expanded="true"/)
  h.state.collapsedCardIds.add(earlier.id)
  assert.match(h.conversationCard(earlier, graph), /aria-expanded="false"/)
  const latestHtml = h.conversationCard(latest, graph)
  assert.match(latestHtml, /data-action="open-continue"/)
  assert.doesNotMatch(latestHtml, /data-action="toggle-card-children"|data-action="open-branch"/)
  assert.doesNotMatch(h.conversationCard({ ...earlier, answer: null }, graph), /data-action="open-branch"/)
})

function liveHarness() {
  const latest = card('latest', { answer: null })
  const frames = []
  let updates = 0
  const context = vm.createContext({
    state: {
      mode: 'canvas', dragging: false, canvasGesture: false, inspectorCardId: null,
      workspace: { threads: [{ id: 'thread-a', dshSessionId: 'session-a' }] },
      liveReplies: new Map([['session-a', { running: true, text: '第一段' }]]),
    },
    canvasGraphCache: { latestByThread: new Map([['thread-a', latest]]) },
    regionView: { overview: false }, regionElements: new Map([['latest', {}]]),
    regionDirtyCards: new Set(), inspectorBodyTimer: 0,
    window: { requestAnimationFrame(callback) { frames.push(callback); return frames.length } },
    syncCanvasViewport() { updates++ },
  })
  vm.runInContext(snippet('let liveCardFrame =', 'function scheduleLiveRender('), context)
  return { context, latest, frames, get updates() { return updates } }
}

test('coalesces streaming chunks and shows the newest text on the latest card', () => {
  const h = liveHarness()
  h.context.scheduleLiveCardUpdate('session-a')
  h.context.state.liveReplies.set('session-a', { running: true, text: '第一段第二段' })
  h.context.scheduleLiveCardUpdate('session-a')
  assert.equal(h.frames.length, 1)
  assert.equal(h.latest.answer, null)
  h.frames.shift()()
  assert.equal(h.latest.answer.text, '第一段第二段')
  assert.equal(h.latest.answer.pending, true)
  assert.equal(h.updates, 1)
})

test('streaming leaves cards alone during gestures and preserves a completed answer', () => {
  const h = liveHarness()
  for (const gesture of ['dragging', 'canvasGesture']) {
    h.context.state[gesture] = true
    h.context.applyLiveReplyToCard('session-a')
    assert.equal(h.latest.answer, null)
    assert.equal(h.updates, 0)
    h.context.state[gesture] = false
  }
  h.context.applyLiveReplyToCard('session-a')
  assert.equal(h.latest.answer.text, '第一段')
  assert.equal(h.updates, 1)
  h.latest.answer = { text: '最终回答', pending: false }
  h.context.state.liveReplies.set('session-a', { running: true, text: '迟到的片段' })
  h.context.applyLiveReplyToCard('session-a')
  assert.equal(h.latest.answer.text, '最终回答')
  assert.equal(h.updates, 1)
})
