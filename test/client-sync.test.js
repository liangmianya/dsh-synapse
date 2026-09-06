import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }
const large = Array.from({ length: 600 }, (_, i) => ({ id: `s${i}`, title: '中文会话标题'.repeat(15) + i, cwd: '/workspace', blank: false }))

// Execute the complete production loader/apply, not a rewritten sync algorithm.
// DOM, DSH stores, clock and HTTP are fixtures; the HTTP fixture models independent
// upsert commits (including a lost response), not the real disk-backed server.
function fixture(initial = []) {
  let sessions = initial, notify, cleanup, now = 0, nextId = 0, active = 0, maxActive = 0
  const timers = new Map(), frames = [], calls = [], messages = [], warnings = [], server = new Map()
  let respond = async () => ({ ok: true, status: 200, json: async () => ({ workspaces: [] }) })
  const element = () => {
    const events = new Map(), classes = new Set()
    return { hidden: false, events, append() {}, remove() {}, setAttribute() {}, hasAttribute: () => false,
      classList: { toggle(k, on) { on ? classes.add(k) : classes.delete(k) }, add(k) { classes.add(k) }, remove(k) { classes.delete(k) } },
      addEventListener(k, fn) { events.set(k, fn) }, removeEventListener(k) { events.delete(k) } }
  }
  const dialog = element(), map = element(), overlay = element(), frame = element(), host = element()
  overlay.hidden = true
  frame.contentWindow = { postMessage(message) { messages.push(message) } }
  host.querySelector = selector => ({ '[data-view="dialog"]': dialog, '[data-view="map"]': map, '.dsh-synapse-overlay': overlay, iframe: frame })[selector]
  const window = { ...element(), setTimeout(fn, ms) { const id = ++nextId; timers.set(id, { fn, at: now + ms, ms }); return id }, clearTimeout(id) { timers.delete(id) }, requestAnimationFrame(fn) { frames.push(fn) } }
  const snapshot = () => ({ ids: sessions.map(s => s.id), current: sessions[0]?.id, byId: Object.fromEntries(sessions.map(s => [s.id, { ...s, displayTitle: s.title }])) })
  const ctx = { sessions: { list: { getSnapshot: snapshot, subscribe(fn) { notify = fn; return () => { notify = undefined } } }, scope() {} },
    workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } }, effect(fn) { cleanup = fn() } }
  window.__ModuleLoader__ = { load({ factory }) { factory().apply(ctx) } }
  vm.runInNewContext(source, { window, document: { head: element(), body: element(), createElement: tag => tag === 'div' ? host : element() }, location: { origin: 'https://fixture.invalid' }, TextEncoder, AbortController, queueMicrotask,
    console: { warn(...args) { warnings.push(args) } }, async fetch(url, options) {
      const body = JSON.parse(options.body)
      calls.push({ body, options }); active++; maxActive = Math.max(maxActive, active)
      for (const s of body.sessions) server.set(s.id, s)
      for (const id of body.removedSessionIds) server.delete(id)
      try { return await respond(options, calls.length) } finally { active-- }
    } })
  return { calls, timers, server, messages, overlay, warnings, get maxActive() { return maxActive },
    notify() { notify?.() }, set(value) { sessions = value }, response(fn) { respond = fn }, dispose() { cleanup() },
    open() { map.events.get('click')() }, close() { dialog.events.get('click')() },
    ready() { window.events.get('message')?.({ origin: 'https://fixture.invalid', data: { source: 'dsh-synapse', type: 'synapse:map-ready' } }) },
    frameLoad() { frame.events.get('load')() }, raf() { frames.splice(0).forEach(fn => fn()) },
    async advance(ms) {
      const target = now + ms
      await settle()
      for (;;) {
        const entry = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!entry) break
        now = entry[1].at; timers.delete(entry[0]); entry[1].fn(); await settle()
      }
      now = target; await settle()
    } }
}

test('apply batches UTF-8 metadata below the server cap and suppresses unchanged list notifications', async () => {
  const h = fixture(large)
  for (let i = 0; i < 10; i++) { h.notify(); await settle() }
  await h.advance(500)
  assert.ok(h.calls.length > 1)
  assert.ok(h.calls.every(c => Buffer.byteLength(c.options.body) <= 24 * 1024))
  assert.deepEqual(h.calls.flatMap(c => c.body.sessions), large.map(s => ({ ...s, parentId: null })))
  const count = h.calls.length
  for (let i = 0; i < 100; i++) { h.notify(); await settle() }
  await h.advance(500)
  assert.equal(h.calls.length, count)
  assert.equal(h.maxActive, 1)
  h.dispose()
})

test('one flight coalesces changed metadata and acknowledges explicit removals', async () => {
  const h = fixture([{ id: 'a', title: 'A' }]); let release
  h.response(() => new Promise(resolve => { release = resolve }))
  h.notify(); await h.advance(500)
  h.set([{ id: 'b', title: 'B' }]); for (let i = 0; i < 30; i++) h.notify()
  await h.advance(500); assert.equal(h.calls.length, 1)
  h.response(async () => ({ ok: true, status: 200, json: async () => ({}) }))
  release({ ok: true, status: 200, json: async () => ({}) }); await settle(); await h.advance(500)
  assert.equal(h.maxActive, 1)
  assert.deepEqual(h.calls.at(-1).body.removedSessionIds, ['a'])
  assert.deepEqual([...h.server.keys()], ['b']); h.dispose()
})

test('partial commits followed by disappearance remove every potentially sent ID', async () => {
  const h = fixture([]); h.notify(); await h.advance(500)
  h.set(large); h.response(async (_, n) => ({ ok: n !== 3, status: n === 3 ? 500 : 200, json: async () => ({ error: 'fixture' }) }))
  h.notify(); await h.advance(500)
  assert.ok(h.server.size > 0 && h.server.size < large.length)
  h.set([]); h.notify(); await h.advance(500)
  assert.equal(h.server.size, 0); h.dispose()
})

test('return to a previously successful signature repairs partial mutation', async () => {
  const h = fixture(large); h.notify(); await h.advance(500)
  const failAt = h.calls.length + 2
  h.response(async (_, n) => ({ ok: n !== failAt, status: n === failAt ? 500 : 200, json: async () => ({}) }))
  h.set(large.map(s => ({ ...s, title: 'changed'.repeat(100) }))); h.notify(); await h.advance(500)
  h.set(large); h.notify(); await h.advance(500)
  assert.deepEqual([...h.server.values()], large.map(s => ({ ...s, parentId: null }))); h.dispose()
})

test('permanent failures suppress identical input; opening the map explicitly retries', async () => {
  const h = fixture([{ id: 'a', title: 'A' }])
  h.response(async () => ({ ok: false, status: 400, json: async () => ({ error: '请求内容过大' }) }))
  h.notify(); await h.advance(500)
  for (let i = 0; i < 20; i++) { h.notify(); await h.advance(500) }
  assert.equal(h.calls.length, 1)
  h.open(); h.raf(); await h.advance(800)
  assert.equal(h.calls.length, 2); h.dispose()
})

test('transient retries are bounded across changing signatures and stale retry cannot revive a permanent failure', async () => {
  const h = fixture([{ id: 'a', title: 'A' }])
  h.response(async () => ({ ok: false, status: 500, json: async () => ({}) }))
  h.notify(); await h.advance(500)
  const stale = [...h.timers.values()].find(t => t.ms === 2000)
  assert.ok(stale)
  h.set([{ id: 'b', title: 'B' }]); h.notify(); await h.advance(500)
  assert.ok([...h.timers.values()].some(t => t.ms === 4000))
  h.set([{ id: 'c', title: 'C' }]); h.notify(); await h.advance(500)
  assert.ok([...h.timers.values()].some(t => t.ms === 8000))
  await h.advance(8500); assert.equal(h.calls.length, 4)
  await h.advance(60000); assert.equal(h.calls.length, 4)
  h.response(async () => ({ ok: false, status: 400, json: async () => ({}) }))
  h.set([{ id: 'd', title: 'D' }]); h.notify(); await h.advance(500)
  stale.fn(); h.notify(); await h.advance(60000)
  assert.equal(h.calls.length, 5); h.dispose()
})

test('timeout aborts a stalled sync and dispose cancels timers and the in-flight request', async () => {
  const h = fixture([{ id: 'a' }])
  h.response(options => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })))
  h.notify(); await h.advance(500); await h.advance(30000)
  assert.equal(h.calls[0].options.signal.aborted, true)
  await h.advance(2500); assert.equal(h.calls.length, 2)
  h.dispose(); await settle(); assert.equal(h.calls[1].options.signal.aborted, true)
  await h.advance(60000); assert.equal(h.calls.length, 2); assert.equal(h.timers.size, 0)
})

test('oversized individual metadata is rejected locally without retry storms', async () => {
  const h = fixture([{ id: 'a', title: '中'.repeat(33000) }])
  h.notify(); await h.advance(500); h.notify(); await h.advance(60000)
  assert.equal(h.calls.length, 0); assert.equal(h.warnings.length, 1); h.dispose()
})

test('map publisher deduplicates metadata, sends title changes, and resends after iframe load', async () => {
  const h = fixture([{ id: 'a', title: 'A' }]); h.open(); h.raf(); h.ready()
  const count = type => h.messages.filter(m => m.type === type).length
  for (let i = 0; i < 100; i++) h.notify()
  assert.equal(count('synapse:workspaces'), 1); assert.equal(count('synapse:current-session'), 1)
  h.set([{ id: 'a', title: 'renamed' }]); h.notify()
  assert.equal(count('synapse:current-session'), 2)
  h.close(); h.set([{ id: 'b', title: 'B' }]); h.notify()
  assert.equal(count('synapse:workspaces'), 1)
  h.open(); h.raf(); h.ready(); assert.equal(count('synapse:workspaces'), 2)
  h.frameLoad(); assert.equal(count('synapse:workspaces'), 3); h.dispose()
})

test('late map-ready and animation frames cannot reopen a closed or disposed overlay', async () => {
  const h = fixture(); h.open(); h.close(); h.raf(); h.ready(); await h.advance(300)
  assert.equal(h.overlay.hidden, true)
  assert.equal(h.messages.filter(m => m.type === 'synapse:map-opened').length, 0)
  h.open(); h.dispose(); h.raf(); await h.advance(300)
  assert.equal(h.messages.filter(m => m.type === 'synapse:map-opened').length, 0)
})
