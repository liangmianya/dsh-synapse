import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
const start = source.indexOf('const MORPH_KEY_ATTRIBUTES =')
const end = source.indexOf('const boundDragHandles =', start)
assert.ok(start >= 0 && end > start, 'missing DOM reconciliation source')

// A small DOM double lets these tests check node identity and edited content
// rather than requiring the streaming renderer to call a particular function.
class DomNode {
  static TEXT_NODE = 3
  static COMMENT_NODE = 8
  constructor(nodeType, nodeValue = null) {
    this.nodeType = nodeType
    this.nodeValue = nodeValue
    this.childNodes = []
    this.parentNode = null
  }
  get firstChild() { return this.childNodes[0] ?? null }
  get nextSibling() {
    const siblings = this.parentNode?.childNodes ?? []
    return siblings[siblings.indexOf(this) + 1] ?? null
  }
  insertBefore(child, before) {
    if (child === before) return child
    child.parentNode?.removeChild(child)
    const index = before === null ? this.childNodes.length : this.childNodes.indexOf(before)
    assert.ok(index >= 0, 'insertion reference belongs to this parent')
    this.childNodes.splice(index, 0, child)
    child.parentNode = this
    return child
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child)
    assert.ok(index >= 0, 'removed node belongs to this parent')
    this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }
  replaceWith(next) {
    const parent = this.parentNode
    parent.insertBefore(next, this)
    parent.removeChild(this)
  }
  cloneNode(deep) {
    const copy = this instanceof DomElement
      ? new DomElement(this.tagName, Object.fromEntries(this.fields))
      : new DomNode(this.nodeType, this.nodeValue)
    if (deep) for (const child of this.childNodes) copy.insertBefore(child.cloneNode(true), null)
    return copy
  }
}
class DomElement extends DomNode {
  constructor(tag, attributes = {}, children = []) {
    super(1)
    this.tagName = tag.toUpperCase()
    this.fields = new Map(Object.entries(attributes))
    for (const child of children) this.insertBefore(child, null)
  }
  get attributes() { return [...this.fields].map(([name, value]) => ({ name, value })) }
  getAttribute(name) { return this.fields.get(name) ?? null }
  hasAttribute(name) { return this.fields.has(name) }
  setAttribute(name, value) { this.fields.set(name, String(value)) }
  removeAttribute(name) { this.fields.delete(name) }
}
class DomInput extends DomElement {}
class DomTextArea extends DomElement {}
const text = value => new DomNode(DomNode.TEXT_NODE, value)
const element = (tag, attributes, ...children) => new DomElement(tag, attributes, children)

function harness() {
  const context = vm.createContext({
    Node: DomNode, Element: DomElement, HTMLInputElement: DomInput, HTMLTextAreaElement: DomTextArea,
  })
  vm.runInContext(source.slice(start, end), context)
  return context
}

test('updates and reorders cards without losing their nodes, scroll or click handlers', () => {
  const h = harness()
  const first = element('article', { 'data-card-id': 'first' }, text('旧回答'))
  const second = element('article', { 'data-card-id': 'second' }, text('另一个回答'))
  first.scrollTop = 180
  const click = () => 'clicked'
  first.onclick = click
  const root = element('section', {}, first, second)
  const next = element('section', {},
    element('article', { 'data-card-id': 'second' }, text('另一个回答')),
    element('article', { 'data-card-id': 'first', class: 'selected' }, text('新回答')),
  )
  h.morphChildren(root, next)
  assert.equal(root.childNodes[0], second)
  assert.equal(root.childNodes[1], first)
  assert.equal(first.firstChild.nodeValue, '新回答')
  assert.equal(first.getAttribute('class'), 'selected')
  assert.equal(first.scrollTop, 180)
  assert.equal(first.onclick, click)
})

test('preserves the composer text while still updating its attributes', () => {
  const h = harness()
  const composer = new DomTextArea('textarea', { 'data-draft': '', class: 'old' }, [text('未发送的输入')])
  const child = composer.firstChild
  composer.value = '未发送的输入'
  const next = new DomTextArea('textarea', { 'data-draft': '', class: 'sending' }, [text('旧草稿')])
  assert.equal(h.morphNode(composer, next), composer)
  assert.equal(composer.firstChild, child)
  assert.equal(composer.value, '未发送的输入')
  assert.equal(composer.getAttribute('class'), 'sending')
})

test('preserves selected answer text while a clicked sidebar row continues updating', () => {
  const h = harness()
  const answer = element('div', { class: 'thread-answer' }, text('正在选中的回答'))
  const selectedText = answer.firstChild
  h.selectedAnswer = answer
  vm.runInContext('morphFrozenRoot = selectedAnswer', h)
  h.morphNode(answer, element('div', { class: 'thread-answer expanded' }, text('稍后更新的回答')))
  assert.equal(answer.firstChild, selectedText)
  assert.equal(answer.getAttribute('class'), 'thread-answer expanded')

  const row = element('button', { 'data-thread': 'a' }, text('旧标题'))
  h.document = { activeElement: row }
  h.morphNode(row, element('button', { 'data-thread': 'a', class: 'active' }, text('新标题')))
  assert.equal(row.getAttribute('class'), 'active')
  assert.equal(row.firstChild.nodeValue, '新标题')
})
