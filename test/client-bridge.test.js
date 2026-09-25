import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

/**
 * These tests drive the browser half against doubles of the v0.1.7-rc.2 Client
 * services. Every double mirrors the published contract of the service it
 * replaces (`@deepseek-ai/dsh-api-session-controller/client`,
 * `@deepseek-ai/dsh-api-workspace-controller/client`,
 * `@deepseek-ai/dsh-client-ui-workspace`, `@deepseek-ai/dsh-client-ui-conversation`),
 * so a call the real Client does not answer fails here instead of in the page.
 */

const TAG = /<([a-z]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>/gi
const ATTRIBUTE = /([a-z-]+)(?:="([^"]*)")?/gi
const ORIGIN = 'http://127.0.0.1:3080'

/**
 * Element double covering the DOM surface `client.js` touches: attributes, a
 * class list, recorded listeners, and flat children parsed from the single
 * static `innerHTML` assignment that builds the plugin's shell.
 * @param tagName - element tag name.
 * @returns the element double.
 */
function element(tagName) {
  const attributes = new Map()
  const listeners = new Map()
  const classes = new Set()
  const node = {
    tagName: tagName.toUpperCase(),
    children: [],
    hidden: false,
    removed: false,
    textContent: '',
    style: {},
    dataset: {},
    className: '',
    classList: {
      add: name => { classes.add(name) },
      remove: name => { classes.delete(name) },
      contains: name => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : force
        if (on) classes.add(name)
        else classes.delete(name)
      },
    },
    setAttribute(name, value) { attributes.set(name, String(value)) },
    getAttribute(name) { return attributes.get(name) ?? null },
    hasAttribute(name) { return attributes.has(name) },
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type) { listeners.delete(type) },
    append(child) { node.children.push(child) },
    remove() { node.removed = true },
    scrollIntoView() { node.scrolled = true },
    querySelector(selector) { return descendants(node).find(child => matches(child, selector)) ?? null },
    dispatch(type, event) { listeners.get(type)?.(event) },
  }
  let innerHTML = ''
  Object.defineProperty(node, 'innerHTML', {
    get: () => innerHTML,
    set: value => {
      innerHTML = value
      node.children = []
      for (const tag of value.matchAll(TAG)) {
        const child = element(tag[1])
        for (const attribute of tag[2].matchAll(ATTRIBUTE)) {
          const name = attribute[1]
          const attributeValue = attribute[2] ?? ''
          child.setAttribute(name, attributeValue)
          if (name === 'class') {
            child.className = attributeValue
            for (const className of attributeValue.split(/\s+/)) if (className !== '') child.classList.add(className)
          }
          if (name === 'hidden') child.hidden = true
        }
        node.children.push(child)
      }
    },
  })
  return node
}

/**
 * @param node - subtree root.
 * @returns every descendant element.
 */
function descendants(node) {
  return node.children.flatMap(child => [child, ...descendants(child)])
}

/**
 * @param node - candidate element.
 * @param selector - `.class`, `[attr="value"]`, or a bare tag name.
 * @returns whether the element matches.
 */
function matches(node, selector) {
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1))
  const attribute = /^\[([a-z-]+)="([^"]*)"\]$/.exec(selector)
  if (attribute !== null) return node.getAttribute(attribute[1]) === attribute[2]
  return node.tagName.toLowerCase() === selector.toLowerCase()
}

/** One Client Session row as `SessionSummary` publishes it. */
function sessionRow(id, fields = {}) {
  return {
    id,
    displayTitle: fields.displayTitle ?? id,
    cwd: fields.cwd,
    parentId: fields.parentId ?? null,
    blank: fields.blank ?? false,
    running: fields.running ?? false,
    retainedBy: fields.retainedBy ?? {},
  }
}

/**
 * Build the browser half's environment and doubles.
 * @param options - Session rows, retained ids, Workspace rows, Chat state, and the anchor row key.
 * @returns the declared inject list, recorded calls, and the page-side controls.
 */
async function loadBridge(options = {}) {
  const rows = new Map((options.sessions ?? []).map(row => [row.id, row]))
  const retained = new Set(options.retained ?? [])
  // Values produced inside the vm carry that realm's prototypes, which strict
  // deep equality rejects; every recorded value crosses back through
  // `structuredClone` so assertions compare this realm's objects.
  const record = (list, value) => { list.push(structuredClone(value)) }
  const calls = { retain: [], released: [], prompts: [], opened: [], created: [], forked: [], fetches: [], subscriptions: 0 }
  const posted = []
  const listListeners = new Set()
  const workspaceListeners = new Set()
  const chatListeners = new Set()
  const sessionListeners = new Set()
  const chatActivated = []
  const windowListeners = new Map()

  const chatSnapshot = {
    // The activated view source `target('chat')` resolves to is the only place
    // the in-flight reply and the anchor seq -> key index remain observable.
    nodes: { values: () => options.chatNodes ?? [] },
    legacy: { partial: options.partial ?? null },
  }

  const sessionFace = id => ({
    sessionId: id,
    getSnapshot: () => ({ sessionId: id, running: rows.get(id)?.running ?? false }),
    subscribe: listener => {
      calls.subscriptions += 1
      sessionListeners.add(listener)
      return () => sessionListeners.delete(listener)
    },
    loadThrough: async () => {},
    prompt: async (content, mode) => {
      record(calls.prompts, { id, content, mode })
      return { ok: true }
    },
  })

  // `ClientSessions.binding(id)` returns `scopes.get(id)?.binding`, so the
  // object is identity-stable for one generation and replaced by the next.
  const bindings = new Map()
  const bindingOf = id => {
    if (!retained.has(id) || !rows.has(id)) return undefined
    let binding = bindings.get(id)
    if (binding === undefined) {
      binding = { sessionId: id, session: sessionFace(id) }
      bindings.set(id, binding)
    }
    return binding
  }

  const sessions = {
    list: {
      getSnapshot: () => ({ ids: [...rows.keys()], byId: Object.fromEntries(rows), phase: 'ready', projectionsBySession: {} }),
      subscribe: listener => {
        calls.subscriptions += 1
        listListeners.add(listener)
        return () => listListeners.delete(listener)
      },
    },
    binding: bindingOf,
    retain: (id, retainOptions) => {
      if (!rows.has(id)) throw new Error(`unknown session ${id}`)
      record(calls.retain, { id, ...retainOptions })
      retained.add(id)
      return {
        sessionId: id,
        binding: bindingOf(id),
        ready: Promise.resolve(),
        release: () => {
          record(calls.released, id)
          retained.delete(id)
          // Retiring the generation retires its binding object.
          bindings.delete(id)
        },
      }
    },
    create: async createOptions => {
      record(calls.created, createOptions)
      const id = 'session-new'
      rows.set(id, sessionRow(id, { cwd: createOptions.cwd }))
      retained.add(id)
      return id
    },
    fork: async forkOptions => {
      record(calls.forked, forkOptions)
      const id = 'session-fork'
      rows.set(id, sessionRow(id, { displayTitle: 'DSH 分支' }))
      return id
    },
  }

  const workspaces = {
    list: {
      getSnapshot: () => ({
        items: options.workspaces ?? [],
        archivedSessionIds: [],
        pinnedSessionIds: [],
        state: 'idle',
        phase: 'ready',
        error: null,
      }),
      subscribe: listener => {
        calls.subscriptions += 1
        workspaceListeners.add(listener)
        return () => workspaceListeners.delete(listener)
      },
    },
  }

  const uiWorkspace = { openSession: target => { record(calls.opened, target) } }

  const uiConversation = {
    binding: id => {
      if (options.chatUnavailable === true) throw new Error('uiConversation.binding: no Chat target registered')
      if (!retained.has(id)) throw new Error(`uiConversation.binding: unknown session "${id}"`)
      return {
        target: name => ({
          getSnapshot: () => chatSnapshot,
          subscribe: listener => {
            calls.subscriptions += 1
            chatActivated.push(name)
            chatListeners.add(listener)
            return () => chatListeners.delete(listener)
          },
        }),
      }
    },
  }

  let dispose = () => {}
  const ctx = {
    sessions,
    workspaces,
    uiWorkspace,
    uiConversation,
    effect: effect => { dispose = effect() },
  }

  class HTMLElement {}
  let anchorScrolled = false
  const documentStub = {
    head: element('head'),
    body: element('body'),
    createElement: tagName => element(tagName),
    querySelector: selector => options.anchorKey !== undefined && selector.includes(options.anchorKey)
      ? Object.assign(new HTMLElement(), { scrollIntoView: () => { anchorScrolled = true } })
      : null,
  }
  documentStub.body.hasAttribute = () => false

  const windowStub = {
    location: { origin: ORIGIN },
    addEventListener: (type, listener) => { windowListeners.set(type, listener) },
    removeEventListener: type => { windowListeners.delete(type) },
    // The bridge's only timers are the overlay-open fallback and the anchor
    // retry, so running them inline keeps the test deterministic.
    setTimeout: callback => { callback(); return 1 },
    clearTimeout: () => {},
    requestAnimationFrame: callback => { callback(); return 1 },
  }

  let factory
  const context = {
    window: windowStub,
    document: documentStub,
    location: { origin: ORIGIN },
    queueMicrotask,
    fetch: async (url, init) => { record(calls.fetches, { url, body: JSON.parse(init.body) }); return { ok: true } },
    CSS: { escape: value => value },
    HTMLElement,
    console,
  }
  // The registration facade the Host shell provides: it only captures the lazy
  // factory, because the bridge registers no side effect before `apply`.
  windowStub.__ModuleLoader__ = { load: descriptor => { factory = descriptor.factory } }
  vm.createContext(context)
  vm.runInContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), context)

  const module = factory({})
  module.apply(ctx)
  // `send` posts through `frame.contentWindow`, which a real iframe populates.
  const frame = documentStub.body.children[0].querySelector('iframe')
  frame.contentWindow = { postMessage: message => { record(posted, message) } }

  return {
    inject: [...module.inject],
    calls,
    posted,
    chatActivated,
    dispose: () => dispose(),
    // Replace a same-id generation without dropping its retention.
    retire: id => { bindings.delete(id) },
    // Flip the Host-reported running bit the list row carries.
    setRunning: (id, running) => { rows.set(id, { ...rows.get(id), running }) },
    message: data => windowListeners.get('message')?.({ origin: ORIGIN, data: { source: 'dsh-synapse', ...data } }),
    shell: () => documentStub.body.children[0],
    overlay: () => documentStub.body.children[0]?.querySelector('.dsh-synapse-overlay'),
    anchorScrolled: () => anchorScrolled,
    chatChanged: () => { for (const listener of [...chatListeners]) listener() },
    listChanged: () => { for (const listener of [...listListeners]) listener() },
    sessionChanged: () => { for (const listener of [...sessionListeners]) listener() },
    postedOf: type => posted.filter(message => message.type === type),
  }
}

test('declares the v0.1.7 Client services it calls', async () => {
  const bridge = await loadBridge()

  assert.deepEqual(bridge.inject, ['sessions', 'workspaces', 'uiWorkspace', 'uiConversation'])
})

test('mounts one switch and one hidden map overlay into the page', async () => {
  const bridge = await loadBridge()

  assert.equal(bridge.shell().className, 'dsh-synapse-host')
  assert.equal(bridge.overlay().hidden, true)
})

test('derives the current session from the Main view reference count', async () => {
  const bridge = await loadBridge({
    sessions: [
      sessionRow('session-idle', { displayTitle: '闲置' }),
      sessionRow('session-current', { displayTitle: '当前', cwd: '/work', retainedBy: { mainView: 1 } }),
    ],
  })

  bridge.message({ type: 'synapse:request-current' })

  assert.deepEqual(bridge.postedOf('synapse:current-session')[0].session, { id: 'session-current', title: '当前', cwd: '/work' })
})

test('reports no current session while nothing retains the Main view', async () => {
  const bridge = await loadBridge({ sessions: [sessionRow('session-idle')] })

  bridge.message({ type: 'synapse:request-current' })

  assert.equal(bridge.postedOf('synapse:current-session')[0].session, null)
})

test('syncs every catalogued session to the canvas endpoint', async () => {
  const bridge = await loadBridge({
    sessions: [
      sessionRow('session-a', { displayTitle: 'A', cwd: '/a' }),
      sessionRow('session-b', { displayTitle: 'B', cwd: '/a', parentId: 'session-a', blank: true }),
    ],
  })

  bridge.message({ type: 'synapse:map-ready' })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(bridge.calls.fetches[0].url, '/synapse/api/sessions/sync')
  assert.deepEqual(bridge.calls.fetches[0].body.sessions, [
    { id: 'session-a', title: 'A', cwd: '/a', parentId: null, blank: false },
    { id: 'session-b', title: 'B', cwd: '/a', parentId: 'session-a', blank: true },
  ])
})

test('activates a session through the Workspace UI without closing the map', async () => {
  const bridge = await loadBridge({ sessions: [sessionRow('session-target', { retainedBy: { mainView: 1 } })] })
  bridge.message({ type: 'synapse:map-ready' })

  bridge.message({ type: 'synapse:activate-session', sessionId: 'session-target' })

  assert.deepEqual(bridge.calls.opened, ['session-target'])
  assert.equal(bridge.overlay().hidden, false)
})

test('opens a session and closes the map without a controller-level open call', async () => {
  const bridge = await loadBridge({ sessions: [sessionRow('session-target', { retainedBy: { mainView: 1 } })] })
  bridge.message({ type: 'synapse:map-ready' })

  bridge.message({ type: 'synapse:open-session', sessionId: 'session-target' })

  assert.deepEqual(bridge.calls.opened, ['session-target'])
  assert.equal(bridge.overlay().hidden, true)
})

test('scrolls the opened conversation to the requested turn anchor', async () => {
  const bridge = await loadBridge({
    sessions: [sessionRow('session-target', { retainedBy: { mainView: 1 } })],
    retained: ['session-target'],
    chatNodes: [{ anchorSeq: 7, key: 'node-7' }],
    anchorKey: 'node-7',
  })
  bridge.message({ type: 'synapse:map-ready' })

  bridge.message({ type: 'synapse:open-session', sessionId: 'session-target', seq: 7 })

  assert.equal(bridge.anchorScrolled(), true)
})

test('sends a prompt through an owned Session reference and releases it', async () => {
  const bridge = await loadBridge({ sessions: [sessionRow('session-live')] })

  bridge.message({ type: 'synapse:send-message', requestId: 'r1', sessionId: 'session-live', text: '  继续分析  ' })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(bridge.calls.retain, [{ id: 'session-live', source: 'synapse' }])
  assert.deepEqual(bridge.calls.prompts, [{ id: 'session-live', content: [{ type: 'text', text: '继续分析' }], mode: 'queue' }])
  assert.deepEqual(bridge.calls.released, ['session-live'])
  assert.deepEqual(bridge.postedOf('synapse:message-sent')[0], { source: 'dsh-synapse', type: 'synapse:message-sent', requestId: 'r1', sessionId: 'session-live' })
})

test('rejects an empty message without acquiring a reference', async () => {
  const bridge = await loadBridge({ sessions: [sessionRow('session-live')] })

  bridge.message({ type: 'synapse:send-message', requestId: 'r1', sessionId: 'session-live', text: '   ' })

  assert.deepEqual(bridge.calls.retain, [])
  assert.equal(bridge.postedOf('synapse:bridge-error')[0].message, '消息不能为空')
})

test('mirrors the streaming reply the activated Chat view publishes', async () => {
  const bridge = await loadBridge({
    sessions: [sessionRow('session-live', { retainedBy: { mainView: 1 }, running: true })],
    retained: ['session-live'],
    partial: { turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: '略' }, { kind: 'text', text: '正在分析' }] },
  })
  bridge.message({ type: 'synapse:map-ready' })

  assert.deepEqual(bridge.chatActivated, ['chat'])
  assert.deepEqual(bridge.postedOf('synapse:live-reply')[0], { source: 'dsh-synapse', type: 'synapse:live-reply', sessionId: 'session-live', running: true, text: '正在分析' })

  bridge.chatChanged()
  assert.equal(bridge.postedOf('synapse:live-reply').length, 2)
  assert.equal(bridge.postedOf('synapse:live-reply')[1].text, '正在分析')
})

test('rebuilds the live record when a same-id generation is replaced', async () => {
  const bridge = await loadBridge({
    sessions: [sessionRow('session-live', { retainedBy: { mainView: 1 } })],
    retained: ['session-live'],
    partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: '第一代' }] },
  })
  bridge.message({ type: 'synapse:map-ready' })
  assert.equal(bridge.calls.subscriptions, 4)
  assert.equal(bridge.postedOf('synapse:live-reply').length, 1)

  bridge.retire('session-live')
  bridge.listChanged()

  // The retired generation's two subscriptions are gone and exactly one fresh
  // pair replaced them.
  assert.equal(bridge.calls.subscriptions, 6)
  assert.equal(bridge.postedOf('synapse:live-reply').length, 2)
  bridge.chatChanged()
  assert.equal(bridge.postedOf('synapse:live-reply').length, 3)
})

test('observes a running Session the Client has not retained', async () => {
  const bridge = await loadBridge({
    sessions: [sessionRow('session-bg', { running: true })],
    partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: '后台在跑' }] },
  })

  bridge.message({ type: 'synapse:map-ready' })

  // The plugin owns the reference that makes this Chat view readable: 0.1.7
  // mints no Session scope implicitly, so a running card would otherwise show
  // no live state at all.
  assert.deepEqual(bridge.calls.retain, [{ id: 'session-bg', source: 'synapse' }])
  assert.deepEqual(bridge.chatActivated, ['chat'])
  assert.deepEqual(bridge.postedOf('synapse:live-reply')[0], { source: 'dsh-synapse', type: 'synapse:live-reply', sessionId: 'session-bg', running: true, text: '后台在跑' })
})

test('releases its own reference once the Session stops running', async () => {
  const bridge = await loadBridge({ sessions: [sessionRow('session-bg', { running: true })] })
  bridge.message({ type: 'synapse:map-ready' })
  assert.deepEqual(bridge.calls.retain, [{ id: 'session-bg', source: 'synapse' }])

  bridge.setRunning('session-bg', false)
  bridge.listChanged()

  assert.deepEqual(bridge.calls.released, ['session-bg'])
  assert.deepEqual(bridge.postedOf('synapse:live-reply').at(-1), { source: 'dsh-synapse', type: 'synapse:live-reply', sessionId: 'session-bg', running: false, text: '' })
})

test('still reports a running Session whose Chat view is unavailable', async () => {
  const bridge = await loadBridge({
    sessions: [sessionRow('session-bg', { running: true })],
    chatUnavailable: true,
  })

  bridge.message({ type: 'synapse:map-ready' })

  assert.deepEqual(bridge.chatActivated, [])
  assert.deepEqual(bridge.postedOf('synapse:live-reply')[0], { source: 'dsh-synapse', type: 'synapse:live-reply', sessionId: 'session-bg', running: true, text: '' })
})

test('leaves an idle Session it neither owns nor needs unobserved', async () => {
  const bridge = await loadBridge({ sessions: [sessionRow('session-idle')] })

  bridge.message({ type: 'synapse:request-current' })

  assert.deepEqual(bridge.chatActivated, [])
  assert.deepEqual(bridge.postedOf('synapse:live-reply'), [])
})

test('creates a session without moving the DSH current selection', async () => {
  const bridge = await loadBridge({ sessions: [] })

  bridge.message({ type: 'synapse:create-session', requestId: 'r1', workspaceId: 'workspace-1' })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(bridge.calls.created, [{ workspaceId: 'workspace-1' }])
  assert.deepEqual(bridge.calls.opened, [])
  assert.deepEqual(bridge.postedOf('synapse:created-session')[0].session, { id: 'session-new', title: 'session-new', cwd: null })
})

test('forks through the Session Controller and reports the child', async () => {
  const bridge = await loadBridge({ sessions: [sessionRow('session-parent')] })

  bridge.message({ type: 'synapse:fork-session', requestId: 'r1', sessionId: 'session-parent', atSeq: 12 })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(bridge.calls.forked, [{ sessionId: 'session-parent', atSeq: 12, increaseTitle: true }])
  assert.deepEqual(bridge.postedOf('synapse:forked-session')[0].session, { id: 'session-fork', title: 'DSH 分支' })
})

test('releases every subscription and removes the shell when disposed', async () => {
  const bridge = await loadBridge({
    sessions: [sessionRow('session-live', { retainedBy: { mainView: 1 } })],
    retained: ['session-live'],
    partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: '正在分析' }] },
  })
  bridge.message({ type: 'synapse:map-ready' })
  const before = bridge.postedOf('synapse:live-reply').length
  // The two service lists plus one Chat and one Session subscription.
  assert.equal(bridge.calls.subscriptions, 4)

  bridge.dispose()
  bridge.chatChanged()
  bridge.listChanged()
  bridge.sessionChanged()

  assert.equal(bridge.postedOf('synapse:live-reply').length, before)
  assert.equal(bridge.shell().removed, true)
})

test('declares the client package of every service the bridge injects', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  // `dsh.client.inject` edges order factory arrival, so every service the
  // browser half waits on needs its own provider package listed.
  const providers = {
    sessions: '@deepseek-ai/dsh-api-session-controller',
    workspaces: '@deepseek-ai/dsh-api-workspace-controller',
    uiWorkspace: '@deepseek-ai/dsh-client-ui-workspace',
    uiConversation: '@deepseek-ai/dsh-client-ui-conversation',
  }
  const bridge = await loadBridge()

  assert.equal(manifest.dsh.client.platform, 'web')
  for (const service of bridge.inject) {
    assert.ok(providers[service] !== undefined, `${service} has no known provider package`)
    assert.ok(manifest.dsh.client.inject.includes(providers[service]), `${service} needs ${providers[service]} in dsh.client.inject`)
  }
})
