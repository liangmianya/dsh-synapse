import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import {
  BODY_LIMITS, LOG_LIMITS, LogLimitError, SessionLogReader,
  bodiesFromEvents, bodyPage, bodySelection, decodeSessionLog,
} from '../session-bodies.js'

const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
const event = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
const frame = events => zstdCompressSync(Buffer.from(events.map(value => JSON.stringify(value)).join('\n') + '\n'))

async function logs(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'synapse-bounded-log-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  async function put(id, data) {
    const path = join(directory, 'workspace', id)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'session.v4.jsonl.zstd'), data)
  }
  return { directory, put, reader: new SessionLogReader(directory, options) }
}

test('caps multibyte, escaped and emoji bodies by actual JSON bytes', () => {
  for (const text of ['汉字'.repeat(100_000), '\u0000"\\\n'.repeat(100_000), '😀'.repeat(100_000)]) {
    const payload = bodiesFromEvents({ messages: [{ sourceSeq: 1 }] }, [event(1, text)], null)['1']
    assert.equal(payload.truncated, true)
    assert.ok(bytes(payload.text) <= BODY_LIMITS.textBytes)
    assert.ok(bytes(payload) <= BODY_LIMITS.messageBytes)
    assert.match(payload.text, /DSH/)
    assert.doesNotMatch(payload.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)
  }
  assert.equal(bodiesFromEvents({ messages: [{ sourceSeq: 1 }] }, [event(1, '短正文')], null)['1'].truncated, false)
})

test('limits tool fields, counts, aggregate JSON and arbitrary metadata', () => {
  const process = Array.from({ length: 100 }, (_, i) => ({
    callId: `c${i}`, name: 'shell', status: 'done', unused: { deep: 'x'.repeat(100_000) },
  }))
  const events = [event(1, '\u0000'.repeat(100_000)), ...process.flatMap(entry => [
    { seq: 2, type: 'tool/call', data: { callId: entry.callId, arguments: '\u0000'.repeat(100_000) } },
    { seq: 3, type: 'tool/result', data: { message: { source: { callId: entry.callId }, content: [{ type: 'text', text: '结果'.repeat(100_000) }] }, error: { message: '出错'.repeat(100_000) } } },
  ])]
  const payload = bodiesFromEvents({ messages: [{ sourceSeq: 1, process }] }, events, null)['1']
  assert.equal(payload.processTruncated, true)
  assert.equal(payload.omittedProcess, process.length - payload.process.length)
  assert.ok(payload.process.length <= BODY_LIMITS.processEntries)
  assert.ok(bytes(payload.process) <= BODY_LIMITS.processBytes)
  assert.ok(bytes(payload) <= BODY_LIMITS.messageBytes)
  for (const entry of payload.process) {
    assert.equal(entry.unused, undefined)
    assert.equal(entry.truncated, true)
    for (const field of ['arguments', 'result', 'error']) assert.ok(bytes(entry[field]) <= BODY_LIMITS.toolFieldBytes)
  }
})

test('does not traverse unrequested message or tool payloads', () => {
  const bomb = {}
  Object.defineProperty(bomb, 'content', { get() { throw new Error('unrelated payload was traversed') } })
  const events = [
    event(1, '选中的正文'),
    { seq: 99, type: 'assistant/message', data: { message: bomb } },
    { seq: 100, type: 'tool/result', data: { message: { source: { callId: 'other' } } } },
  ]
  Object.defineProperty(events[2].data.message, 'content', Object.getOwnPropertyDescriptor(bomb, 'content'))
  assert.equal(bodiesFromEvents({ messages: [{ sourceSeq: 1 }, { sourceSeq: 99 }] }, events, [1])['1'].text, '选中的正文')
})

test('nested and cyclic tool results are bounded without stack overflow', () => {
  const content = []
  content.push({ type: 'text', text: '前缀' }, { type: 'tool-result', content })
  const data = { message: { source: { callId: 'cycle' }, content } }
  const payload = bodiesFromEvents({ messages: [{ sourceSeq: 1, process: [{ callId: 'cycle' }] }] }, [
    event(1, '正文'), { seq: 2, type: 'tool/result', data },
  ], null)['1']
  assert.equal(payload.process[0].truncated, true)
  assert.ok(bytes(payload) < BODY_LIMITS.messageBytes)
})

test('response pages honor byte budgets and cursors cover every requested message', () => {
  const messages = Array.from({ length: 20 }, (_, sourceSeq) => ({ sourceSeq }))
  const events = messages.map(message => event(message.sourceSeq, '\u0000'.repeat(100_000)))
  const payloads = bodiesFromEvents({ messages }, events, null)
  const seen = []
  let cursor = 0
  do {
    const response = bodyPage(messages.slice(cursor), payloads, cursor, messages.length)
    assert.ok(bytes(response) <= BODY_LIMITS.responseBytes)
    seen.push(...Object.keys(response.messages).map(Number))
    assert.ok(response.nextCursor === null || response.nextCursor > cursor)
    cursor = response.nextCursor
  } while (cursor !== null)
  assert.deepEqual(seen, messages.map(message => message.sourceSeq))
})

test('decodes concatenated, skippable and partial frames and split UTF-8 JSON lines', async t => {
  const f = await logs(t)
  const text = JSON.stringify(event(2, '第二帧😀')) + '\n'
  const buffer = Buffer.from(text)
  const split = buffer.indexOf(Buffer.from('😀')) + 2
  const skip = Buffer.alloc(11)
  skip.writeUInt32LE(0x184d2a50)
  skip.writeUInt32LE(3, 4)
  const full = Buffer.concat([frame([event(1, '第一帧')]), skip, zstdCompressSync(buffer.subarray(0, split)), zstdCompressSync(buffer.subarray(split))])
  const data = Buffer.concat([full, frame([event(3, '尾帧')]).subarray(0, 8)])
  await f.put('session', data)
  const decoded = decodeSessionLog(data)
  assert.match(decoded, /第二帧😀/)
  const events = await f.reader.events('session', bodySelection([{ sourceSeq: 1 }, { sourceSeq: 2 }]))
  assert.deepEqual(events.map(value => value.seq), [1, 2])
  const bodies = bodiesFromEvents({ messages: [{ sourceSeq: 1 }, { sourceSeq: 2 }] }, events, null)
  assert.equal(bodies['2'].text, '第二帧😀')
})

test('parses frame boundaries even when raw blocks contain zstd magic', () => {
  const payload = Buffer.from([65, 0x28, 0xb5, 0x2f, 0xfd, 66])
  const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, payload.length])
  const block = Buffer.alloc(3)
  block.writeUIntLE((payload.length << 3) | 1, 0, 3)
  const raw = Buffer.concat([header, block, payload])
  assert.equal(decodeSessionLog(Buffer.concat([raw, zstdCompressSync(Buffer.from('尾'))])), Buffer.concat([payload, Buffer.from('尾')]).toString('utf8'))
})

test('rejects compressed, frame, total decoded and line limits before caching', async t => {
  const cases = [
    [{ compressedBytes: 10 }, frame([event(1, '内容')])],
    [{ frameBytes: 100 }, frame([event(1, 'x'.repeat(10_000))])],
    [{ decodedBytes: 150, frameBytes: 150 }, Buffer.concat([frame([event(1, 'a')]), frame([event(2, 'b')])])],
    [{ lineBytes: 100 }, frame([event(1, 'x'.repeat(1000))])],
    [{ cacheBytes: 300 }, frame([event(1, 'x'.repeat(1000))])],
  ]
  for (const [options, data] of cases) {
    const f = await logs(t, options)
    await f.put('session', data)
    await assert.rejects(f.reader.events('session'), LogLimitError)
    assert.equal(f.reader.cacheBytes, 0)
    assert.equal(f.reader.activeReads, 0)
  }
})

test('default frame limit rejects a highly compressed decompression bomb', async t => {
  const f = await logs(t)
  const bomb = zstdCompressSync(Buffer.alloc(LOG_LIMITS.frameBytes + 1, 65))
  assert.ok(bomb.length < 1024)
  await f.put('session', bomb)
  await assert.rejects(f.reader.events('session'), LogLimitError)
  assert.throws(() => decodeSessionLog(bomb), LogLimitError)
})

test('unknown-size frames still enforce maxOutputLength', async t => {
  const f = await logs(t, { frameBytes: 50 })
  const data = Buffer.alloc(100, 65)
  // No content size in the header; a 1 KiB window and a raw last block.
  const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0])
  const block = Buffer.alloc(3)
  block.writeUIntLE((data.length << 3) | 1, 0, 3)
  const compressed = Buffer.concat([header, block, data])
  await f.put('session', compressed)
  await assert.rejects(f.reader.events('session'), LogLimitError)
  assert.throws(() => decodeSessionLog(compressed, { frameBytes: 50 }), LogLimitError)
})

test('selected caches exclude unrelated history and evict by bytes with mtime invalidation', async t => {
  const f = await logs(t, { cacheBytes: 2000, cacheEntries: 4 })
  await f.put('session', frame([event(1, 'a'.repeat(200)), event(2, 'b'.repeat(200)), event(3, 'x'.repeat(50_000))]))
  const first = bodySelection([{ sourceSeq: 1 }])
  const second = bodySelection([{ sourceSeq: 2 }])
  const a = await f.reader.events('session', first)
  assert.deepEqual(a.map(value => value.seq), [1])
  assert.equal(await f.reader.events('session', first), a)
  await f.reader.events('session', second)
  assert.ok(f.reader.cacheBytes <= 2000)
  assert.equal(f.reader.cache.size, 1)
  await f.put('session', frame([event(2, '更新后的正文')]))
  const updated = await f.reader.events('session', second)
  assert.equal(updated[0].synapseBody, '更新后的正文')
  assert.ok(f.reader.cacheBytes <= 2000)
})

test('same reads share work, active readers stay bounded and overflow returns a limit', async t => {
  const f = await logs(t, { concurrency: 2, pendingReads: 3 })
  for (const id of ['a', 'b', 'c']) await f.put(id, frame([event(1, id)]))
  let release
  const gate = new Promise(resolve => { release = resolve })
  let finds = 0
  const original = f.reader.findLog.bind(f.reader)
  f.reader.findLog = async id => { finds += 1; await gate; return original(id) }
  const a = f.reader.events('a')
  const duplicate = f.reader.events('a')
  const b = f.reader.events('b')
  const c = f.reader.events('c')
  assert.equal(f.reader.activeReads, 2)
  assert.equal(f.reader.waiters.length, 1)
  assert.equal(finds, 2)
  await assert.rejects(f.reader.events('overflow'), LogLimitError)
  release()
  const values = await Promise.all([a, duplicate, b, c])
  assert.equal(values[0], values[1])
  assert.equal(finds, 3)
  assert.equal(f.reader.activeReads, 0)
  assert.equal(f.reader.inflight.size, 0)
  assert.equal(f.reader.waiters.length, 0)
})

test('cache entry limit, missing files and real I/O errors release reader resources', async t => {
  const f = await logs(t)
  for (let i = 0; i < 6; i++) {
    await f.put(`session${i}`, frame([event(1, `内容${i}`)]))
    await f.reader.events(`session${i}`)
  }
  assert.equal(f.reader.cache.size, 4)
  assert.ok(f.reader.cacheBytes <= LOG_LIMITS.cacheBytes)
  await rm(join(f.directory, 'workspace', 'session5'), { recursive: true })
  assert.equal(await f.reader.events('session5'), null)
  assert.equal(f.reader.cache.size, 3)
  const failure = Object.assign(new Error('disk failure'), { code: 'EIO' })
  f.reader.findLog = async () => { throw failure }
  await assert.rejects(f.reader.events('broken'), error => error === failure)
  assert.equal(f.reader.activeReads, 0)
  assert.equal(f.reader.inflight.size, 0)
})
