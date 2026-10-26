import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

/**
 * `morph-render.test.js` only checks that the morph functions exist. That let a
 * real regression through: `data-thread` labels every control inside a card, so
 * two sibling buttons that share a thread id produced the same key, the second
 * one patched the first one's node, and the loser was dropped as unmatched.
 * These tests drive `morphChildren` itself against a minimal DOM.
 */

/** Element double: attributes, child list, cloning, and the sibling walks morph needs. */
class Element {
  constructor(tagName) {
    this.nodeType = 1
    this.tagName = tagName.toUpperCase()
    this.childNodes = []
    this.parentNode = null
    this.attributes = new Map()
  }

  get firstChild() {
    return this.childNodes[0] ?? null
  }

  get nextSibling() {
    if (this.parentNode === null) return null
    const index = this.parentNode.childNodes.indexOf(this)
    return this.parentNode.childNodes[index + 1] ?? null
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  contains(node) {
    for (let current = node; current !== null && current !== undefined; current = current.parentNode) {
      if (current === this) return true
    }
    return false
  }

  append(child) {
    return this.insertBefore(child, null)
  }

  insertBefore(child, reference) {
    if (child.parentNode !== null) child.parentNode.removeChild(child)
    const index = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference)
    this.childNodes.splice(index === -1 ? this.childNodes.length : index, 0, child)
    child.parentNode = this
    return child
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child)
    if (index !== -1) this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }

  replaceWith(next) {
    const parent = this.parentNode
    if (parent === null) return
    parent.insertBefore(next, this)
    parent.removeChild(this)
  }

  cloneNode(deep) {
    const copy = new Element(this.tagName)
    for (const [name, value] of this.attributes) copy.attributes.set(name, value)
    if (deep) for (const child of this.childNodes) copy.insertBefore(child.cloneNode(true), null)
    return copy
  }
}

/**
 * Load just the morph implementation out of `app.js`.
 * @returns `morphChildren`, running in a context wired to the DOM double.
 */
async function loadMorph() {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const start = source.indexOf('const MORPH_KEY_ATTRIBUTES')
  const end = source.indexOf('function bindDragHandle')
  assert.ok(start !== -1 && end > start, 'the morph block is present in app.js')
  const context = {
    globalThis: {},
    Element,
    HTMLElement: Element,
    Node: { TEXT_NODE: 3, COMMENT_NODE: 8 },
    document: { activeElement: null },
    window: {},
  }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)};globalThis.morphChildren = morphChildren;globalThis.morphNode = morphNode`, context)
  return { morphChildren: context.globalThis.morphChildren, morphNode: context.globalThis.morphNode, context, source }
}

/**
 * Build one card control.
 * @param fields - the action and thread label the markup carries.
 * @returns the button element.
 */
function control(fields) {
  const button = new Element('button')
  button.setAttribute('data-action', fields.action)
  if (fields.thread !== undefined) button.setAttribute('data-thread', fields.thread)
  if (fields.card !== undefined) button.setAttribute('data-card', fields.card)
  return button
}

/**
 * Build the markup the morph has to patch into.
 * @param buttons - controls to mount inside one container.
 * @returns the container element.
 */
function container(buttons) {
  const footer = new Element('footer')
  for (const fields of buttons) footer.append(control(fields))
  return footer
}

const FOOTER = [
  { action: 'show-thread', thread: 'session-1' },
  { action: 'open-dsh', thread: 'session-1' },
  { action: 'archive-thread', thread: 'session-1' },
]

test('keeps every sibling control that shares one thread id', async () => {
  const { morphChildren } = await loadMorph()
  const live = container(FOOTER)

  // The first render mounts into an empty container; the second one is where a
  // colliding key used to collapse three buttons into the last patched one.
  morphChildren(live, container(FOOTER))
  assert.deepEqual(live.childNodes.map(node => node.getAttribute('data-action')), [
    'show-thread',
    'open-dsh',
    'archive-thread',
  ])
})

test('keeps the follow-up and branch buttons apart', async () => {
  const { morphChildren } = await loadMorph()
  const buttons = [
    { action: 'open-continue', thread: 'session-1', card: 'card-1' },
    { action: 'open-branch', thread: 'session-1', card: 'card-1' },
  ]
  const live = container(buttons)
  morphChildren(live, container(buttons))
  morphChildren(live, container(buttons))
  assert.deepEqual(live.childNodes.map(node => node.getAttribute('data-action')), ['open-continue', 'open-branch'])
})

test('keeps rendering the shell while a child holds the caret', async () => {
  const { morphNode, context } = await loadMorph()

  // Selecting text (the 追问 flow starts with a selection) put a caret owner
  // inside `<main>`. Testing `contains` froze every ancestor, so the page kept
  // its old markup while the state moved on — clicks looked dead.
  const paragraph = new Element('p')
  const live = new Element('main')
  live.append(paragraph)
  context.window.getSelection = () => ({ rangeCount: 1, anchorNode: paragraph })

  const next = new Element('main')
  next.append(new Element('section'))
  const patched = morphNode(live, next)

  assert.equal(patched, live, 'the shell node is reused')
  assert.deepEqual(live.childNodes.map(node => node.tagName), ['SECTION'])
})

test('keeps patching a composer that has focus', async () => {
  const { morphNode, context } = await loadMorph()

  // The draft textarea focuses itself, and it must keep its caret without
  // freezing the render of its own shell.
  const composer = new Element('textarea')
  const live = new Element('main')
  live.append(composer)
  context.document.activeElement = composer

  const next = new Element('main')
  next.append(new Element('p'))
  const patched = morphNode(live, next)

  assert.equal(patched, live, 'the shell node is reused')
  assert.deepEqual(live.childNodes.map(node => node.tagName), ['P'])
})

test('reuses the same nodes instead of rebuilding the container', async () => {
  const { morphChildren } = await loadMorph()
  const live = container(FOOTER)
  const original = [...live.childNodes]

  morphChildren(live, container(FOOTER))
  assert.deepEqual(live.childNodes, original)
})
