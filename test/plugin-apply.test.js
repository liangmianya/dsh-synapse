import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'

/**
 * Drives the host half through the v0.1.7-rc.2 contracts it consumes: the
 * `webServer` route registry, the untagged (global) `session/created` and
 * `session/event` listeners, and the `Session` surface a projection replay
 * reads. A Session double here exposes `snapshotEvents()` and
 * `inheritedEventCount`, because the plugin's old readers (`session.events`,
 * `header.seedLength`) were removed and their absence must fail this test.
 */

/**
 * Build one `Session` double.
 * @param fields - identity, durable fork cut, cwd, and the recorded log.
 * @returns the session double.
 */
function hostSession(fields) {
  return {
    id: fields.id,
    header: fields.cwd === undefined ? {} : { cwd: fields.cwd },
    inheritedEventCount: fields.inheritedEventCount ?? 0,
    // The log is reachable only through the v0.1.7 reader: a double that also
    // exposed the removed `events` getter would let the old host half pass.
    snapshotEvents: () => fields.events,
  }
}

/**
 * Build the composing context the host half is mounted into.
 * @param options - the live sessions `ctx.sessions.list()` reports.
 * @returns the context, the registered routes, and the recorded listeners.
 */
function hostContext(options = {}) {
  const routes = []
  const listeners = new Map()
  const sessions = options.sessions ?? []
  const ctx = {
    logger: { warn: () => {}, error: () => {} },
    webServer: {
      register: route => {
        routes.push({ kind: route.kind, path: route.path })
        return () => {}
      },
    },
    sessions: { list: () => sessions },
    on: (type, handler) => {
      listeners.set(type, [...listeners.get(type) ?? [], handler])
      return () => {}
    },
    effect: effect => effect(),
  }
  return {
    ctx,
    routes,
    sessions,
    emit: async (type, ...args) => {
      for (const handler of listeners.get(type) ?? []) await handler(...args)
    },
  }
}

/**
 * Poll until the store's debounced write contains `predicate`, or fail the wait.
 * @param dataFile - the store's JSON file.
 * @param predicate - receives the parsed state.
 * @returns the parsed state that satisfied the predicate.
 */
async function waitForState(dataFile, predicate) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    // The store loads and creates the file asynchronously after `apply` returns.
    const state = await readFile(dataFile, 'utf8').then(JSON.parse, () => undefined)
    if (state !== undefined && predicate(state)) return state
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('the debounced projection write did not reach the data file')
}

test('mounts its own routes on the existing DSH Web Server', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-apply-routes-'))
  const host = hostContext()

  apply(host.ctx, { dataFile: join(directory, 'state.json') })

  assert.deepEqual(host.routes, [
    { kind: 'exact', path: '/synapse' },
    { kind: 'exact', path: '/synapse/' },
    { kind: 'exact', path: '/synapse/app.js' },
    { kind: 'exact', path: '/synapse/styles.css' },
    { kind: 'exact', path: '/synapse/deepseek-mark.svg' },
    { kind: 'prefix', path: '/synapse/api' },
  ])
})

test('replays the sessions already live at mount through snapshotEvents()', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-apply-replay-'))
  const dataFile = join(directory, 'state.json')
  const host = hostContext({
    sessions: [hostSession({
      id: 'session-live',
      cwd: 'C:\\work\\live',
      events: [
        { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '已存在的会话' }] } },
        { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '回答' }] } } },
      ],
    })],
  })

  apply(host.ctx, { dataFile })
  const state = await waitForState(dataFile, value => value.workspaces.length === 1)

  assert.equal(state.workspaces[0].cwd, 'C:\\work\\live')
  assert.deepEqual(state.workspaces[0].threads[0].messages.map(message => message.text), ['已存在的会话', '回答'])
})

test('projects only the child-owned tail of a fork through inheritedEventCount', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-apply-fork-'))
  const dataFile = join(directory, 'state.json')
  const host = hostContext({
    sessions: [hostSession({
      id: 'session-child',
      cwd: 'C:\\work\\fork',
      // The first two events belong to the parent the canvas already shows; the
      // durable fork cut is what replaced `header.seedLength`.
      inheritedEventCount: 2,
      events: [
        { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '父会话问题' }] } },
        { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '父会话回答' }] } } },
        { type: 'user/message', seq: 2, time: 3, data: { content: [{ type: 'text', text: '分支追问' }] } },
      ],
    })],
  })

  apply(host.ctx, { dataFile })
  const state = await waitForState(dataFile, value => value.workspaces.length === 1)

  const thread = state.workspaces[0].threads[0]
  assert.equal(thread.sourceSeedLength, 2)
  assert.deepEqual(thread.messages.map(message => message.text), ['分支追问'])
})

test('projects committed events delivered through the global session feed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-apply-feed-'))
  const dataFile = join(directory, 'state.json')
  const session = hostSession({ id: 'session-feed', cwd: 'C:\\work\\feed', events: [] })
  const host = hostContext({ sessions: [session] })

  apply(host.ctx, { dataFile })
  await host.emit('session/event', session, { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '实时事件' }] } })
  const state = await waitForState(dataFile, value => value.workspaces.length === 1)

  assert.deepEqual(state.workspaces[0].threads[0].messages.map(message => message.text), ['实时事件'])
})

test('tracks a session created after mount', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-synapse-apply-created-'))
  const dataFile = join(directory, 'state.json')
  const host = hostContext()

  apply(host.ctx, { dataFile })
  await host.emit('session/created', hostSession({
    id: 'session-created',
    cwd: 'C:\\work\\created',
    events: [{ type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '新会话' }] } }],
  }))
  const state = await waitForState(dataFile, value => value.workspaces.length === 1)

  assert.deepEqual(state.workspaces[0].threads[0].messages.map(message => message.text), ['新会话'])
})
