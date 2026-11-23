import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
function snippet(from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + from.length)
  assert.ok(start >= 0 && end > start, `missing boundary: ${from}`)
  return source.slice(start, end)
}

function harness(kind = 'zoom') {
  let document
  class Target {
    listeners = new Map()
    addEventListener(type, listener, { signal } = {}) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type).add(listener)
      signal?.addEventListener('abort', () => this.listeners.get(type).delete(listener), { once: true })
    }
    emit(type, fields = {}) {
      const event = { target: this, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true }, stopPropagation() {}, ...fields }
      for (const listener of [...this.listeners.get(type) ?? []]) listener(event)
      return event
    }
  }
  class Element extends Target {
    dataset = {}
    attributes = new Map()
    style = {}
    isConnected = true
    disabled = false
    tabIndex = -1
    get scrollHeight() { return (this.items?.length ?? 0) * 32 + 8 }
    setAttribute(name, value) { this.attributes.set(name, String(value)) }
    getAttribute(name) { return this.attributes.get(name) }
    getClientRects() { return this.isConnected ? [{}] : [] }
    getBoundingClientRect() { return { left: 880, right: 960, top: 646, bottom: 684, width: 80 } }
    focus() { document.activeElement = this; document.emit('focusin', { target: this }) }
    scrollIntoView() {}
    contains(target) { return target === this || this.items?.includes(target) === true }
    closest(selector) { return selector === '[data-canvas-menu-item]' && this.dataset.canvasMenuItem !== undefined ? this : null }
    remove() { this.isConnected = false }
    set innerHTML(html) {
      this.items = [...html.matchAll(/<button\b([^>]*)>/g)].map(match => {
        const item = new HTMLButtonElement()
        item.dataset.canvasMenuItem = /data-canvas-menu-item="(\d+)"/.exec(match[1])[1]
        item.disabled = /\bdisabled\b/.test(match[1])
        return item
      })
    }
    querySelectorAll() { return this.items }
  }
  class HTMLButtonElement extends Element {}
  document = new Target()
  document.documentElement = { clientWidth: 1000 }
  document.body = { append(menu) { document.menu = menu } }
  document.createElement = () => new Element()
  const window = new Target()
  window.innerHeight = 700
  const trigger = new HTMLButtonElement()
  trigger.dataset.canvasMenu = kind
  document.activeElement = trigger
  const calls = []
  const context = vm.createContext({
    document, window, Element, HTMLButtonElement, AbortController,
    escapeHtml: value => String(value),
    state: { mode: 'canvas', zoom: .6, workspace: { id: 'a' }, focusedThreadId: null,
      selectedCardId: null, canvasCards: [{ id: 'card-a' }], canvasCardsById: new Map([['card-a', {}]]) },
    closeSelectMenu() {},
    zoomCanvasAtCenter: delta => calls.push(['zoom', delta]),
    fitCanvasCards: selected => calls.push(['fit', Boolean(selected)]),
    focusActiveCard: () => calls.push(['focus']),
    openShortcutHelp: () => calls.push(['help']),
    resetCardPositions: () => calls.push(['positions']),
    resetCanvasCamera: () => calls.push(['camera']),
    render: () => calls.push(['render']),
    setError: error => { throw error },
  })
  vm.runInContext([
    snippet('function selectMenuPlacement(', 'function positionSelectMenu('),
    snippet('let activeCanvasMenu =', "document.addEventListener('click', event => {\n  const trigger = event.target instanceof Element ? event.target.closest('[data-canvas-menu]')"),
  ].join('\n'), context)
  const open = options => context.openCanvasMenu(trigger, options)
  const key = value => document.menu.emit('keydown', { key: value })
  const choose = index => document.menu.emit('click', { target: document.menu.items[index] })
  return { context, document, window, trigger, calls, open, key, choose }
}

test('zoom menu opens above the bottom toolbar, skips unavailable items and restores focus on Escape', () => {
  const h = harness()
  h.open()
  const menu = h.document.menu
  assert.equal(menu.getAttribute('role'), 'menu')
  assert.equal(menu.items[2].disabled, true)
  assert.ok(Number.parseFloat(menu.style.top) < h.trigger.getBoundingClientRect().top)
  assert.equal(h.document.activeElement, menu.items[0])
  h.key('ArrowDown')
  assert.equal(h.document.activeElement, menu.items[1])
  h.key('ArrowDown')
  assert.equal(h.document.activeElement, menu.items[0])
  h.key('End')
  assert.equal(h.document.activeElement, menu.items[1])
  h.key('Escape')
  assert.equal(menu.isConnected, false)
  assert.equal(h.document.activeElement, h.trigger)
  assert.equal(h.trigger.getAttribute('aria-expanded'), 'false')
  assert.equal(h.document.listeners.get('pointerdown').size, 0)
  assert.equal(h.window.listeners.get('resize').size, 0)
})

test('menu items recheck selection and scope before changing the camera', () => {
  const h = harness()
  h.context.state.selectedCardId = 'card-a'
  h.open()
  h.context.state.selectedCardId = null
  h.choose(2)
  assert.deepEqual(h.calls, [])
  h.open()
  h.context.state.workspace.id = 'b'
  h.choose(1)
  assert.deepEqual(h.calls, [])
  h.open()
  h.choose(0)
  assert.deepEqual(h.calls, [['zoom', .4]])
})

test('polling preserves an unchanged menu and closes it when its scope changes', () => {
  const h = harness()
  h.open()
  const menu = h.document.menu
  h.context.syncCanvasMenus()
  assert.equal(menu.isConnected, true)
  h.context.state.focusedThreadId = 'thread-a'
  h.context.syncCanvasMenus()
  assert.equal(menu.isConnected, false)
  assert.equal(h.document.listeners.get('focusin').size, 0)
})

test('outside pointerdown closes the menu without taking focus back', () => {
  const h = harness('more')
  h.open()
  const menu = h.document.menu
  const focused = h.document.activeElement
  h.document.emit('pointerdown', { target: {} })
  assert.equal(menu.isConnected, false)
  assert.equal(h.document.activeElement, focused)
  h.open()
  h.choose(0)
  assert.deepEqual(h.calls, [['positions'], ['camera'], ['render']])
})

test('zoom label updates preserve the menu arrow and announce the new value', () => {
  const label = { textContent: '100%' }
  const arrow = {}
  const attributes = new Map()
  const button = { children: [label, arrow], querySelector: () => label,
    setAttribute: (name, value) => attributes.set(name, value) }
  const context = vm.createContext({
    state: { zoom: 1.25 }, document: { querySelector: () => button },
  })
  vm.runInContext(snippet('function syncCanvasZoomLabel(', 'function zoomCanvas('), context)
  context.syncCanvasZoomLabel()
  assert.equal(label.textContent, '125%')
  assert.equal(button.children[1], arrow)
  assert.match(attributes.get('aria-label'), /125%/)
})
