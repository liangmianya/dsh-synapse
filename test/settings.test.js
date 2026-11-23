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
const key = 'dsh-synapse:preferences:v1'
const defaults = { zoomSpeed: 'standard', wheelBehavior: 'pan', sendShortcut: 'modifier-enter', readingSize: 'standard', theme: 'host' }
const plain = value => JSON.parse(JSON.stringify(value))

function harness({ saved = null, storageDenied = false } = {}) {
  const storage = new Map(saved === null ? [] : [[key, saved]])
  const listeners = new Map()
  const dataset = {}
  let cancellations = 0
  const state = {
    workspace: { id: 'workspace', threads: [{ id: 'thread', messages: [{ text: '原始正文' }] }] },
    quickPhrases: ['自定义词'], cardPositions: new Map([['card', { x: 123, y: 456 }]]),
    collapsedCardIds: new Set(['card']), branchAnchors: new Map([['session', 'card']]),
    canvasCamera: { x: -400, y: 70 }, zoom: .7, draft: { text: '未发送内容' },
  }
  const context = vm.createContext({
    state,
    DEFAULT_QUICK_PHRASES: ['展开说明', '举例', '通俗易懂', '对比解释'],
    document: { documentElement: { dataset } },
    localStorage: {
      getItem(name) { if (storageDenied) throw new Error('denied'); return storage.get(name) ?? null },
      setItem(name, value) { if (storageDenied) throw new Error('denied'); storage.set(name, value) },
    },
    cancelCanvasZoom() { cancellations++ },
    persistQuickPhrases() { storage.set('dsh-synapse:quick-phrases:v1', JSON.stringify(state.quickPhrases)) },
    window: { location: { origin: 'http://localhost' }, addEventListener: (type, listener) => listeners.set(type, listener) },
  })
  vm.runInContext([
    snippet('const PREFERENCES_KEY =', 'const DEFAULT_QUICK_PHRASES ='),
    snippet("window.addEventListener('message', event =>", "post('synapse:request-current')"),
  ].join('\n'), context)
  const theme = dark => listeners.get('message')({
    origin: 'http://localhost', data: { source: 'dsh-synapse', type: 'synapse:theme', dark },
  })
  return { context, state, storage, dataset, theme, get cancellations() { return cancellations } }
}

test('reloads preferences and safely falls back for malformed, partial and blocked storage', () => {
  for (const saved of ['null', '[]', 'false', '"text"', '{bad', '{"zoomSpeed":10,"readingSize":"huge","theme":"unknown"}']) {
    const h = harness({ saved })
    assert.deepEqual(plain(vm.runInContext('preferences', h.context)), defaults)
    assert.equal(h.dataset.readingSize, 'standard')
  }
  const partial = harness({ saved: '{"zoomSpeed":"fast","extra":"ignored"}' })
  assert.deepEqual(plain(vm.runInContext('preferences', partial.context)), { ...defaults, zoomSpeed: 'fast' })
  const saved = { zoomSpeed: 'slow', readingSize: 'large', theme: 'dark' }
  const h = harness({ saved: JSON.stringify(saved) })
  assert.deepEqual(plain(vm.runInContext('preferences', h.context)), { ...defaults, ...saved })
  assert.equal(h.dataset.theme, 'dark')
  assert.equal(h.dataset.readingSize, 'large')
  const denied = harness({ storageDenied: true })
  assert.doesNotThrow(() => denied.context.setPreference('theme', 'dark'))
  assert.equal(denied.dataset.theme, 'dark')
})

test('manual theme remains selected across host updates and follow mode uses the latest host theme', () => {
  const h = harness()
  h.theme(true)
  assert.equal(h.dataset.theme, 'dark')
  h.context.setPreference('theme', 'light')
  h.theme(true)
  assert.equal(h.dataset.theme, 'light')
  h.context.setPreference('theme', 'host')
  assert.equal(h.dataset.theme, 'dark')
  h.theme(false)
  assert.equal(h.dataset.theme, 'light')
  h.context.setPreference('theme', 'dark')
  h.theme(false)
  assert.equal(h.dataset.theme, 'dark')
  h.context.setPreference('theme', 'host')
  assert.equal(h.dataset.theme, 'light')
})

test('setting zoom speed stops a pending zoom and preferences persist without changing the viewport', () => {
  const h = harness()
  const before = plain({ camera: h.state.canvasCamera, zoom: h.state.zoom })
  h.context.setPreference('zoomSpeed', 'fast')
  assert.equal(h.cancellations, 1)
  h.context.setPreference('readingSize', 'large')
  assert.equal(h.cancellations, 1)
  h.context.setPreference('unrelated', 'value')
  assert.deepEqual(JSON.parse(h.storage.get(key)), { ...defaults, zoomSpeed: 'fast', readingSize: 'large' })
  assert.deepEqual(plain({ camera: h.state.canvasCamera, zoom: h.state.zoom }), before)
  const reloaded = harness({ saved: h.storage.get(key) })
  assert.equal(reloaded.dataset.readingSize, 'large')
})

test('new input preferences migrate old settings and preserve the camera and draft', () => {
  const h = harness({ saved: '{"theme":"pink","wheelBehavior":"invalid","sendShortcut":"invalid"}' })
  const before = plain({ camera: h.state.canvasCamera, zoom: h.state.zoom, draft: h.state.draft })
  assert.equal(vm.runInContext('preferences.wheelBehavior', h.context), 'pan')
  assert.equal(vm.runInContext('preferences.sendShortcut', h.context), 'modifier-enter')
  h.context.setPreference('wheelBehavior', 'zoom')
  h.context.setPreference('sendShortcut', 'enter')
  assert.equal(h.cancellations, 1)
  const reloaded = harness({ saved: h.storage.get(key) })
  assert.deepEqual(plain(vm.runInContext('preferences', reloaded.context)), {
    ...defaults, theme: 'pink', wheelBehavior: 'zoom', sendShortcut: 'enter',
  })
  assert.deepEqual(plain({ camera: h.state.canvasCamera, zoom: h.state.zoom, draft: h.state.draft }), before)
})

test('restore defaults preserves conversations, positions, folds, anchors, camera and unsent text', () => {
  const h = harness({ saved: '{"zoomSpeed":"fast","readingSize":"large","theme":"light"}' })
  h.theme(true)
  const before = {
    workspace: plain(h.state.workspace), positions: plain([...h.state.cardPositions]),
    folds: [...h.state.collapsedCardIds], anchors: [...h.state.branchAnchors],
    camera: plain(h.state.canvasCamera), zoom: h.state.zoom, draft: plain(h.state.draft),
  }
  h.context.restoreDefaultPreferences()
  assert.deepEqual(JSON.parse(h.storage.get(key)), defaults)
  assert.deepEqual(plain(h.state.quickPhrases), ['展开说明', '举例', '通俗易懂', '对比解释'])
  assert.equal(h.dataset.theme, 'dark')
  assert.equal(h.dataset.readingSize, 'standard')
  assert.equal(h.cancellations, 1)
  assert.deepEqual({
    workspace: plain(h.state.workspace), positions: plain([...h.state.cardPositions]),
    folds: [...h.state.collapsedCardIds], anchors: [...h.state.branchAnchors],
    camera: plain(h.state.canvasCamera), zoom: h.state.zoom, draft: plain(h.state.draft),
  }, before)
})

test('editing first-run quick phrases never changes the defaults used by Restore', () => {
  for (const stored of [null, '{bad json']) {
    const errors = []
    const context = vm.createContext({
      QUICK_PHRASES_KEY: 'dsh-synapse:quick-phrases:v1',
      state: {}, localStorage: { getItem: () => stored, setItem() {} },
      setError: message => errors.push(message), render() {},
    })
    vm.runInContext([
      snippet('const DEFAULT_QUICK_PHRASES =', 'const savedBranchAnchors ='),
      snippet('function persistQuickPhrases(', 'function rememberCardPosition('),
      snippet('function addQuickPhrase(', 'function settingsButton('),
      'state.quickPhrases = savedQuickPhrases;',
    ].join('\n'), context)
    assert.equal(context.addQuickPhrase('新的词'), true)
    assert.equal(context.updateQuickPhrase(0, '改过的词'), true)
    assert.equal(context.updateQuickPhrase(1, '改过的词'), false)
    assert.equal(errors.length, 1)
    assert.deepEqual(plain(vm.runInContext('DEFAULT_QUICK_PHRASES', context)), ['展开说明', '举例', '通俗易懂', '对比解释'])
    assert.equal(context.state.quickPhrases.length, 5)
  }
})
