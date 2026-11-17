import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply, WorkspaceStore } from '../index.js'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'synapse-session-query-'))
  const dataFile = join(directory, 'state.json')
  const store = new WorkspaceStore(dataFile)
  t.after(() => {
    clearTimeout(store.flushTimer)
    return rm(directory, { recursive: true, force: true })
  })
  await store.syncSessions([
    { id: 'parent', cwd: 'C:\\alpha', title: '父会话' },
    { id: 'child', cwd: 'C:\\alpha', title: '分支', parentId: 'parent' },
    { id: 'other-cwd', cwd: 'C:\\beta', title: '跨目录会话' },
    { id: 'unrelated', cwd: 'C:\\gamma', title: '无关会话' },
  ])
  const [child] = await store.threadsForSessions(['child'])
  await store.updateThread(child.id, { position: { x: 123, y: 456 } })
  await store.addMessage(child.id, '分支内容')
  await store.flush()
  return { store, dataFile }
}

test('queries only selected sessions across cwd groups and preserves their graph', async t => {
  const { store, dataFile } = await fixture(t)
  const before = await readFile(dataFile, 'utf8')
  const threads = await store.threadsForSessions(['parent', 'child', 'other-cwd', 'child', 'missing'])
  assert.deepEqual(threads.map(thread => thread.dshSessionId).sort(), ['child', 'other-cwd', 'parent'])
  const child = threads.find(thread => thread.dshSessionId === 'child')
  assert.equal(child.parentId, threads.find(thread => thread.dshSessionId === 'parent').id)
  assert.deepEqual(child.position, { x: 123, y: 456 })
  assert.equal(child.messages[0].text, '分支内容')
  child.messages[0].text = '客户端改动'
  assert.equal((await store.threadsForSessions(['child']))[0].messages[0].text, '分支内容')
  assert.deepEqual(await store.threadsForSessions([]), [])
  assert.equal(await readFile(dataFile, 'utf8'), before)
})

test('session query API returns partial matches and retains validation and Host checks', async t => {
  const { dataFile } = await fixture(t)
  let handler
  apply({
    logger: { warn() {}, error() {} },
    sessions: { list() { throw new Error('a selector query must not read session bodies') } },
    effect: effect => effect(),
    webServer: { register(route) { if (route.path === '/synapse/api') handler = route.handler; return () => {} } },
  }, { dataFile, autoProjection: false })
  async function request(body, { host = 'localhost:3000', method = 'POST' } = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    Object.assign(req, { headers: { host }, method, url: '/synapse/api/threads/query' })
    let status
    let result
    await handler(req, { writeHead(code) { status = code }, end(value) { result = JSON.parse(value) } })
    return { status, body: result }
  }
  const result = await request({ sessionIds: ['child', 'other-cwd', 'missing'] })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.threads.map(thread => thread.dshSessionId).sort(), ['child', 'other-cwd'])
  assert.equal((await request({ sessionIds: ['missing'] })).body.threads.length, 0)
  for (const body of [null, {}, { sessionIds: 'child' }, { sessionIds: [null] }, { sessionIds: [' '] }]) {
    assert.equal((await request(body)).status, 400)
  }
  assert.equal((await request({ sessionIds: ['child'] }, { host: 'untrusted.example' })).status, 403)
  assert.equal((await request({ sessionIds: [] }, { method: 'GET' })).status, 404)
  assert.equal((await request({ sessionIds: ['x'.repeat(33 * 1024)] })).status, 400)
})
