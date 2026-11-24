import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
const snippet = (from, to) => {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + from.length)
  assert.ok(start >= 0 && end > start, `missing boundary: ${from}`)
  return source.slice(start, end)
}
const plain = value => JSON.parse(JSON.stringify(value))

class EventTarget {
  listeners = new Map()
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }
  dispatch(type, fields = {}) {
    const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, ...fields }
    for (const listener of [...this.listeners.get(type) ?? []]) listener(event)
    return event
  }
}
class Element extends EventTarget {
  dataset = {}
  matches = new Map()
  style = {}
  isConnected = true
  captured = new Set()
  classes = new Set()
  classList = {
    add: (...names) => names.forEach(name => this.classes.add(name)),
    remove: (...names) => names.forEach(name => this.classes.delete(name)),
    toggle: (name, force) => force ? this.classes.add(name) : this.classes.delete(name),
  }
  closest(selector) { return this.matches.get(selector) ?? null }
  setPointerCapture(id) { this.captured.add(id) }
  hasPointerCapture(id) { return this.captured.has(id) }
  releasePointerCapture(id) { this.captured.delete(id) }
}
class HTMLElement extends Element {}
class HTMLTextAreaElement extends HTMLElement {}
class HTMLFormElement extends HTMLElement {}
class HTMLDialogElement extends HTMLElement {}

function harness() {
  const document = new EventTarget()
  const window = new EventTarget()
  const app = new EventTarget()
  const viewport = new HTMLElement()
  const card = new HTMLElement()
  const title = new HTMLElement()
  const frames = new Map()
  const saves = []
  const actions = []
  let nextFrame = 0
  viewport.focus = () => { document.activeElement = viewport }
  viewport.matches.set('.canvas-viewport, .canvas-controls', viewport)
  viewport.matches.set('.canvas-viewport', viewport)
  viewport.getBoundingClientRect = () => ({ width: 1000, height: 700, left: 0, top: 0 })
  card.style = { left: '100px', top: '200px' }
  card.dataset = { cardId: 'a', positionKey: 'alias' }
  for (const [selector, result] of [
    ['.canvas-viewport', viewport], ['.thread-card', card],
    ['[data-drag-card], [data-card-drag-title]', title],
    ['button, a, select, [role="button"]', title],
  ]) title.matches.set(selector, result)
  document.activeElement = viewport
  document.querySelector = selector => selector === '.canvas-viewport' ? viewport : null
  app.querySelectorAll = () => []
  window.requestAnimationFrame = callback => { const id = ++nextFrame; frames.set(id, callback); return id }
  window.cancelAnimationFrame = id => frames.delete(id)
  const dataCard = { id: 'a', position: { x: 100, y: 200 } }
  const context = vm.createContext({
    document, window, app, Element, HTMLElement, HTMLTextAreaElement, HTMLFormElement, HTMLDialogElement,
    state: { zoom: .5, mode: 'canvas', mapVisible: true, canvasCamera: { x: -20, y: 30 },
      canvasCardsById: new Map([['a', dataCard]]), inspectorCardId: null },
    preferences: { sendShortcut: 'modifier-enter' },
    canvasGraphCache: { index: { set() {} } }, regionView: null,
    activeSelectMenu: null, activeCanvasMenu: null, canvasZoomAnimation: null, pendingWheelPan: null,
    refreshCardConnectors() {}, applyCanvasTransform() {}, syncCanvasViewport() {}, deferCanvasRefresh() {},
    rememberCardPosition: (id, position, aliases) => saves.push({ id, position: plain(position), aliases: [...aliases] }),
    cancelCanvasZoom() {}, closeSelectMenu() {}, closeCanvasMenu() {}, closeCardInspector() {},
    zoomCanvasAtCenter: delta => actions.push(['zoom', delta]),
    fitCanvasCards: selected => actions.push(['fit', selected]),
    focusActiveCard: options => actions.push(['focus', plain(options)]),
    openShortcutHelp: () => actions.push(['help']),
  })
  vm.runInContext([
    snippet('const DRAG_THRESHOLD =', 'function zoomCanvas('),
    snippet("app.addEventListener('pointerdown', event => {\n  const viewport = canvasViewport", "app.addEventListener('wheel', event =>"),
    snippet('function isEditableTarget(', "app.addEventListener('dblclick', event =>"),
  ].join('\n'), context)
  const pointer = (type, fields = {}) => ({ pointerId: 1, button: 0, clientX: 10, clientY: 10, target: title, ...fields })
  return {
    context, state: context.state, viewport, title, card, dataCard, saves, frames, document, window, app, actions,
    down: fields => app.dispatch('pointerdown', pointer('pointerdown', fields)),
    move: fields => document.dispatch('pointermove', pointer('pointermove', fields)),
    up: fields => document.dispatch('pointerup', pointer('pointerup', fields)),
    step() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()) },
    key: (key, fields = {}) => document.dispatch('keydown', { key, target: document.activeElement, ...fields }),
  }
}

test('only primary left title drags move cards, and subthreshold clicks never save a position', () => {
  const h = harness()
  for (const fields of [{ button: 2 }, { isPrimary: false }]) {
    h.down(fields)
    assert.equal(h.state.dragging, undefined)
  }
  h.down()
  h.move({ clientX: 12, clientY: 12 })
  h.up({ clientX: 12, clientY: 12 })
  assert.deepEqual(h.saves, [])
  assert.deepEqual(plain(h.dataCard.position), { x: 100, y: 200 })
  h.down()
  h.move({ pointerId: 2, clientX: 110 })
  assert.equal(h.frames.size, 0)
  h.move({ clientX: 20, clientY: 15 })
  h.step()
  assert.deepEqual(plain(h.dataCard.position), { x: 120, y: 210 })
  assert.equal(h.card.hasPointerCapture(1), true)
  h.up({ clientX: 25, clientY: 20 })
  assert.deepEqual(h.saves, [{ id: 'a', position: { x: 130, y: 220 }, aliases: ['alias'] }])
  assert.equal(h.card.hasPointerCapture(1), false)
  assert.equal(h.state.dragging, false)
})

test('Escape restores an unfinished card drag and cleans up pending frames', () => {
  const h = harness()
  h.down()
  h.move({ clientX: 60, clientY: 40 })
  h.step()
  h.move({ clientX: 70 })
  h.key('Escape')
  assert.deepEqual(plain(h.dataCard.position), { x: 100, y: 200 })
  assert.equal(h.frames.size, 0)
  assert.equal(h.card.hasPointerCapture(1), false)
  assert.deepEqual(h.saves, [])
  assert.equal(h.document.listeners.get('pointermove').size, 0)
  h.move({ clientX: 100 })
  assert.equal(h.frames.size, 0)
})

test('window blur commits an unfinished card drag instead of snapping it back', () => {
  // A release that moves focus out of the iframe arrives after the user has
  // already positioned the card; the gesture commits at that position (the
  // bug was restoring the drag origin on this path).
  const h = harness()
  h.down()
  h.move({ clientX: 60, clientY: 40 })
  h.step()
  h.move({ clientX: 70 })
  h.window.dispatch('blur')
  assert.deepEqual(plain(h.dataCard.position), { x: 220, y: 200 })
  assert.equal(h.frames.size, 0)
  assert.equal(h.card.hasPointerCapture(1), false)
  assert.equal(h.saves.length, 1)
  assert.deepEqual(h.saves[0].position, { x: 220, y: 200 })
  assert.equal(h.document.listeners.get('pointermove').size, 0)
  h.move({ clientX: 100 })
  assert.equal(h.frames.size, 0)
})

test('Space and middle button pan in screen pixels, then release temporary mode on blur', () => {
  for (const mode of ['space', 'middle', 'hand']) {
    const h = harness()
    if (mode === 'space') h.key(' ')
    if (mode === 'hand') h.key('h')
    h.down({ button: mode === 'middle' ? 1 : 0 })
    h.move({ clientX: 60, clientY: 30 })
    h.up({ clientX: 60, clientY: 30 })
    assert.deepEqual(plain(h.state.canvasCamera), { x: 30, y: 50 })
    assert.deepEqual(plain(h.dataCard.position), { x: 100, y: 200 })
    assert.deepEqual(h.saves, [])
    h.window.dispatch('blur')
    assert.equal(vm.runInContext('spacePan', h.context), false)
  }
})

test('map keys respect focus, modifiers and composition; fit uses physical Digit keys', () => {
  const h = harness()
  h.key('!', { shiftKey: true, code: 'Digit1' })
  h.key('@', { shiftKey: true, code: 'Digit2' })
  h.key('f')
  assert.deepEqual(h.actions, [['fit', false], ['fit', true], ['focus', { preferSelection: true }]])
  const input = new HTMLTextAreaElement()
  input.matches.set('input, textarea, select', input)
  h.document.activeElement = input
  h.key('h')
  h.key('+')
  h.document.activeElement = h.viewport
  h.key('+', { ctrlKey: true })
  h.key('h', { isComposing: true })
  h.document.activeElement = new HTMLElement()
  h.key('f')
  assert.equal(h.actions.length, 3)
  assert.equal(vm.runInContext('canvasTool', h.context), 'select')
})

test('Space keeps native button activation instead of entering temporary pan mode', () => {
  const h = harness()
  const button = new HTMLElement()
  button.matches.set('.canvas-viewport, .canvas-controls', button)
  button.matches.set('button, [role="button"]', button)
  h.document.activeElement = button
  const event = h.key(' ')
  assert.equal(event.defaultPrevented, false)
  assert.equal(vm.runInContext('spacePan', h.context), false)
})

test('composer submit ignores IME, repeats and newline chords in both preferences', () => {
  const h = harness()
  const input = new HTMLTextAreaElement()
  const form = new HTMLFormElement()
  let sends = 0
  input.value = '未发送文字'
  input.matches.set('form[data-draft], form[data-compose]', form)
  form.requestSubmit = () => { sends++ }
  const enter = fields => h.app.dispatch('keydown', { key: 'Enter', target: input, ...fields })
  enter({})
  enter({ ctrlKey: true, shiftKey: true })
  enter({ ctrlKey: true, isComposing: true })
  enter({ ctrlKey: true, keyCode: 229 })
  h.app.dispatch('compositionstart', { target: input })
  enter({ ctrlKey: true })
  h.app.dispatch('compositionend', { target: input })
  enter({ ctrlKey: true, repeat: true })
  assert.equal(sends, 0)
  assert.equal(enter({ ctrlKey: true }).defaultPrevented, true)
  enter({ metaKey: true })
  assert.equal(sends, 2)
  h.context.preferences.sendShortcut = 'enter'
  assert.equal(enter({ shiftKey: true }).defaultPrevented, false)
  assert.equal(enter({}).defaultPrevented, true)
  assert.equal(sends, 3)
  input.value = ' '
  enter({})
  assert.equal(sends, 3)
})

test('a draft already being sent cannot submit a second new session or fork', async () => {
  for (const kind of ['new', 'branch', 'continue']) {
    const context = vm.createContext({
      state: { draft: { kind, text: '内容', sending: true } },
      render() { throw new Error('duplicate submission must not render or invoke RPC') },
    })
    vm.runInContext(snippet('async function submitDraft()', 'function threadsById()'), context)
    await context.submitDraft()
    assert.equal(context.state.draft.sending, true)
  }
})
