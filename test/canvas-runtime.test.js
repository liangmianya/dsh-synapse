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
  vm.runInContext(snippet('function zoomCanvas(', 'function zoomCanvasAtCenter('), context)
  const viewport = { getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelector: () => null }
  for (const [requested, expected] of [[0.05, 0.2], [9, 4], [0.5, 0.5]]) {
    context.zoomCanvas(viewport, requested, 100, 100)
    assert.equal(context.state.zoom, expected)
  }
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
