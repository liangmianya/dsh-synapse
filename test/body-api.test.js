import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'
import { apply, WorkspaceStore } from '../index.js'
import { BODY_LIMITS, LOG_LIMITS } from '../session-bodies.js'

async function fixture(t, { tools = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'synapse-body-api-'))
  const dataFile = join(directory, 'state.json')
  const events = Array.from({ length: 60 }, (_, seq) => seq % 2
    ? { seq, time: seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `回答${seq}` }] } } }
    : { seq, time: seq, type: 'user/message', data: { content: [{ type: 'text', text: `问题${seq}` }] } })
  if (tools) events.push(
    { seq: 60, time: 60, type: 'tool/call', data: { callId: 'call', name: 'shell', arguments: '{"cmd":"build"}' } },
    { seq: 61, time: 61, type: 'tool/result', data: { message: { source: { callId: 'call' }, content: [{ type: 'text', text: '构建完成' }] } } },
  )
  let snapshots = 0
  const session = { id: 'session', header: { cwd: 'C:\\test' }, snapshotEvents() { snapshots += 1; return events } }
  const store = new WorkspaceStore(dataFile)
  await store.projectSession(session)
  await store.flush()
  const [thread] = await store.threadsForSessions(['session'])
  t.after(() => { clearTimeout(store.flushTimer); return rm(directory, { recursive: true, force: true }) })
  const sessions = [session]
  let handler
  const errors = []
  apply({
    logger: { warn() {}, error(error) { errors.push(error) } },
    sessions: { list: () => sessions }, effect: fn => fn(),
    webServer: { register(route) { if (route.path === '/synapse/api') handler = route.handler; return () => {} } },
  }, { dataFile, sessionsDir: directory, autoProjection: false })
  async function request(query = '', host = 'localhost') {
    const req = Readable.from([])
    Object.assign(req, { method: 'GET', headers: { host }, url: `/synapse/api/threads/${thread.id}/full${query ? `?${query}` : ''}` })
    let status, body, raw
    await handler(req, { writeHead(code) { status = code }, end(value) { raw = value; body = JSON.parse(value) } })
    return { status, body, bytes: Buffer.byteLength(raw) }
  }
  async function closedLog(data) {
    sessions.length = 0
    const path = join(directory, 'workspace', 'session')
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'session.v4.jsonl.zstd'), data)
  }
  return { events, thread, request, closedLog, sessions, errors, snapshots: () => snapshots }
}

test('body API defaults to twenty messages and validates selectors and pagination before reading', async t => {
  const f = await fixture(t)
  const page = await f.request()
  assert.equal(page.status, 200, f.errors.map(error => error.stack).join('\n'))
  assert.equal(Object.keys(page.body.messages).length, 20)
  assert.equal(page.body.nextCursor, 20)
  assert.equal(page.body.total, 60)
  assert.equal(page.body.messages['0'].text, '问题0')
  const second = await f.request('cursor=20')
  assert.equal(second.body.messages['20'].text, '问题20')
  const subset = await f.request('seqs=14,2,14&limit=1')
  assert.deepEqual(Object.keys(subset.body.messages), ['2'])
  assert.equal(subset.body.total, 2)
  assert.equal(subset.body.nextCursor, 1)
  assert.deepEqual(Object.keys((await f.request('seqs=14,2&limit=1&cursor=1')).body.messages), ['14'])
  assert.equal((await f.request('cursor=999')).body.nextCursor, null)
  const before = f.snapshots()
  for (const query of ['seqs=', 'seqs=-1', 'seqs=1abc', 'seqs=1.2', 'seqs=1,,2', 'seqs=9007199254740992',
    `seqs=${Array.from({ length: 41 }, (_, i) => i).join(',')}`, 'cursor=-1', 'cursor=1x', 'limit=0', 'limit=21']) {
    assert.equal((await f.request(query)).status, 400, query)
  }
  assert.equal(f.snapshots(), before)
  assert.equal((await f.request('', 'untrusted.example')).status, 403)
})

test('byte-limited API pages can advance less than the count limit without skipping messages', async t => {
  const f = await fixture(t)
  for (const value of f.events) {
    const content = value.type === 'user/message' ? value.data.content : value.data.message.content
    content[0].text = '\u0000'.repeat(100_000)
  }
  const seen = []
  let cursor = 0
  do {
    const response = await f.request(`cursor=${cursor}`)
    assert.equal(response.status, 200, f.errors.map(error => error.stack).join('\n'))
    assert.ok(response.bytes <= BODY_LIMITS.responseBytes)
    assert.ok(Object.keys(response.body.messages).length < BODY_LIMITS.pageMessages)
    seen.push(...Object.keys(response.body.messages).map(Number))
    cursor = response.body.nextCursor
  } while (cursor !== null)
  assert.deepEqual(seen, Array.from({ length: 60 }, (_, i) => i))
})

test('missing or over-limit closed logs preserve the requested previews and say why', async t => {
  const f = await fixture(t)
  f.sessions.length = 0
  const missing = await f.request('seqs=1')
  assert.equal(missing.status, 200, f.errors.map(error => error.stack).join('\n'))
  assert.equal(missing.body.unavailable, true)
  assert.equal(missing.body.messages['1'].text, '回答1')
  assert.equal(missing.body.messages['1'].previewOnly, true)
  await f.closedLog(zstdCompressSync(Buffer.alloc(LOG_LIMITS.frameBytes + 1, 65)))
  const limited = await f.request('seqs=1')
  assert.equal(limited.status, 200)
  assert.match(limited.body.warning, /DSH/)
  assert.equal(limited.body.messages['1'].reason, 'limit')
  assert.equal(limited.body.messages['1'].text, '回答1')
  assert.ok(limited.bytes <= BODY_LIMITS.responseBytes)
  assert.equal(f.errors.length, 0)
})

test('closed body API reads selected bodies and preserves previews for missing events', async t => {
  const f = await fixture(t)
  const values = f.events.filter(value => value.seq === 1)
  await f.closedLog(zstdCompressSync(Buffer.from(values.map(value => JSON.stringify(value)).join('\n'))))
  const response = await f.request('seqs=1,2')
  assert.equal(response.body.messages['1'].text, '回答1')
  assert.equal(response.body.messages['1'].previewOnly, undefined)
  assert.equal(response.body.messages['2'].text, '问题2')
  assert.equal(response.body.messages['2'].reason, 'missing')
  assert.equal(response.body.nextCursor, null)
})

test('closed body pages include only the selected message tool payloads', async t => {
  const f = await fixture(t, { tools: true })
  await f.closedLog(zstdCompressSync(Buffer.from(f.events.map(value => JSON.stringify(value)).join('\n') + '\n')))
  const response = await f.request('seqs=59')
  assert.equal(response.status, 200)
  assert.equal(response.body.messages['59'].process[0].arguments, '{"cmd":"build"}')
  assert.equal(response.body.messages['59'].process[0].result, '构建完成')
  const other = await f.request('seqs=1')
  assert.equal(other.body.messages['1'].process.length, 0)
})
