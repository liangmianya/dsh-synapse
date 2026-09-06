import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8')
function between(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a)
  assert.ok(a >= 0 && b > a, `production source boundaries: ${start} / ${end}`)
  return source.slice(a, b)
}
const apiSource = between(source.includes('const pendingReads') ? 'const pendingReads' : 'async function api(', 'function post(')
const loadSource = between('function currentDshWorkspace()', 'function openNewSession()')
const handlerSource = between("window.addEventListener('message', event =>", "post('synapse:request-current')")
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }

// Real API, projection aggregation, load generations, refresh chain and message
// handler; only HTTP, rendering/camera hooks and browser events are stubbed.
function fixture() {
  let listener, renders = 0, active = 0, maxActive = 0
  const calls = [], releases = []
  const state = { summaries: [{ id: 'p', updatedAt: 'old' }], workspace: { id: 'dsh:a', threads: [] }, selectedDshWorkspaceId: 'a',
    currentDsh: null, activeId: null, workspaceLoad: 0, dshWorkspaces: [{ id: 'a', title: 'A', sessionIds: ['s'] }, { id: 'b', title: 'B', sessionIds: ['t'] }], mapCardSessionSwitches: new Set() }
  let response = async path => ({ ok: true, json: async () => path === '/synapse/api/workspaces' ? { workspaces: state.summaries } : { workspace: { id: path, threads: [{ id: 'ts', dshSessionId: 's' }, { id: 'tt', dshSessionId: 't' }, { id: 'other', dshSessionId: 'other' }] } } })
  const context = { state, window: { location: { origin: 'https://fixture.invalid' }, addEventListener(type, fn) { listener = fn } },
    console, resetCanvasCamera() {}, canReplaceView: () => true, render() { renders++ }, loadThreadHistory: async () => {},
    revealConversationThread() {}, conversationCards: () => [], focusActiveCard() {}, setError(error) { throw error },
    async fetch(path, options) {
      calls.push({ path, options }); active++; maxActive = Math.max(maxActive, active)
      try { return await response(path, options) } finally { active-- }
    } }
  vm.createContext(context)
  vm.runInContext(apiSource + loadSource + handlerSource + ';globalThis.fixtureApi={api,openDshWorkspace,refreshProjection,threadsForDshWorkspace}', context)
  return { state, calls, releases, api: context.fixtureApi, get maxActive() { return maxActive }, get renders() { return renders },
    response(fn) { response = fn }, message(type, payload) { listener({ origin: 'https://fixture.invalid', data: { source: 'dsh-synapse', type, ...payload } }) } }
}

test('identical GETs share one flight; distinct GETs use at most two permits; failures release both', async () => {
  const h = fixture()
  h.response(() => new Promise(resolve => h.releases.push(() => resolve({ ok: true, json: async () => ({}) }))))
  const same = Array.from({ length: 100 }, () => h.api.api('/same'))
  await settle(); const sameCalls = h.calls.length
  h.releases.splice(0).forEach(fn => fn()); await Promise.all(same)
  assert.equal(sameCalls, 1)
  const different = Array.from({ length: 10 }, (_, i) => h.api.api(`/different/${i}`))
  for (let i = 0; i < 10; i++) { await settle(); h.releases.splice(0).forEach(fn => fn()) }
  await Promise.all(different); assert.equal(h.maxActive, 2)
  h.response(async () => { throw new Error('transport failure') })
  await assert.rejects(h.api.api('/failure'), /transport failure/)
  h.response(async () => ({ ok: false, json: async () => ({ error: 'HTTP failure' }) }))
  await assert.rejects(h.api.api('/failure'), /HTTP failure/)
  h.response(async () => ({ ok: true, json: async () => ({ recovered: true }) }))
  assert.equal((await h.api.api('/failure')).recovered, true)
  const before = h.calls.length
  await Promise.all([h.api.api('/write', { method: 'POST' }), h.api.api('/write', { method: 'POST' })])
  assert.equal(h.calls.length - before, 2)
})

test('workspace aggregation reads sequentially and preserves only requested threads in order', async () => {
  const h = fixture(); h.state.summaries = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}` }))
  const threads = await h.api.threadsForDshWorkspace({ sessionIds: ['s'] })
  assert.equal(threads.length, 8); assert.ok(threads.every(t => t.dshSessionId === 's'))
  assert.equal(h.maxActive, 1)
  assert.deepEqual(h.calls.map(c => c.path), h.state.summaries.map(s => `/synapse/api/workspaces/${s.id}`))
})

test('changed summary poll performs one selected projection scan, not two', async () => {
  const h = fixture()
  h.response(async path => ({ ok: true, json: async () => path === '/synapse/api/workspaces' ? { workspaces: [{ id: 'p', updatedAt: 'new' }] } : { workspace: { threads: [] } } }))
  assert.equal(await h.api.refreshProjection(), true)
  assert.equal(h.calls.filter(c => c.path === '/synapse/api/workspaces/p').length, 1)
  assert.equal(h.renders, 1)
})

for (const sameId of [false, true]) test(`unchanged summary poll recovers ${sameId ? 'same-ID refresh' : 'A-to-B switch'} after a failed load`, async () => {
  const h = fixture(); let fail = true
  if (sameId) h.state.workspace = { id: 'dsh:b', threads: [] }
  h.response(async path => {
    if (path !== '/synapse/api/workspaces' && fail) { fail = false; throw new Error('temporary') }
    return { ok: true, json: async () => path === '/synapse/api/workspaces' ? { workspaces: h.state.summaries } : { workspace: { threads: [{ id: 'recovered', dshSessionId: 't' }] } } }
  })
  await assert.rejects(h.api.openDshWorkspace('b'), /temporary/)
  await h.api.refreshProjection()
  assert.equal(h.state.workspace.id, 'dsh:b')
  assert.equal(h.state.workspace.threads[0]?.id, 'recovered')
})

test('actual message handler ignores identical workspaces/current session but preserves real metadata changes', async () => {
  const h = fixture()
  for (let i = 0; i < 100; i++) h.message('synapse:workspaces', { workspaces: JSON.parse(JSON.stringify(h.state.dshWorkspaces)) })
  await settle(); assert.equal(h.calls.length, 0); assert.equal(h.renders, 0)
  const changedOther = h.state.dshWorkspaces.map(w => w.id === 'b' ? { ...w, title: 'renamed B' } : w)
  h.message('synapse:workspaces', { workspaces: changedOther }); await settle(); assert.equal(h.calls.length, 0)
  h.message('synapse:workspaces', { workspaces: changedOther.map(w => w.id === 'a' ? { ...w, title: 'renamed A' } : w) })
  await settle(); assert.equal(h.calls.length, 1); assert.equal(h.state.workspace.title, 'renamed A')
  h.state.currentDsh = { id: 's', title: 'A' }
  const before = h.renders
  for (let i = 0; i < 100; i++) h.message('synapse:current-session', { session: { id: 's', title: 'A' } })
  assert.equal(h.renders, before)
  h.message('synapse:current-session', { session: { id: 's', title: 'renamed' } })
  assert.equal(h.state.currentDsh.title, 'renamed'); assert.equal(h.renders, before + 1)
})

test('a late obsolete projection cannot replace a newer selected workspace', async () => {
  const h = fixture(); const releases = []
  h.response(() => new Promise(resolve => { releases.push(() => resolve({ ok: true, json: async () => ({ workspace: { threads: [] } }) })) }))
  const a = h.api.openDshWorkspace('a'); await settle()
  const b = h.api.openDshWorkspace('b'); await settle()
  // The patched API shares the in-flight projection; baseline creates two.
  // This test preserves the existing generation guard, not request cancellation.
  releases.at(-1)(); await b
  if (releases.length > 1) releases[0]()
  await a
  assert.equal(h.state.workspace.id, 'dsh:b')
})
