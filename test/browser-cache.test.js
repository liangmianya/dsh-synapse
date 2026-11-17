import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

const source = await readFile(new URL('../browser-cache.js', import.meta.url), 'utf8')
const context = vm.createContext({ AbortController })
vm.runInContext(`${source}\nglobalThis.cacheAPI = SynapseCache`, context)
const { ByteLru, BodyCache, BodyLoader, LIMITS, textBytes } = context.cacheAPI
const item = (seq, threadId = 'a', revision = 'v1') => ({ threadId, seq, revision })
const body = text => ({ text, process: [], truncated: false })
const selectors = path => new URL(path, 'http://local').searchParams.get('seqs').split(',').map(Number)
const response = seqs => ({ messages: Object.fromEntries(seqs.map(seq => [seq, body(`正文${seq}`)])), nextCursor: null })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const turn = () => new Promise(resolve => setImmediate(resolve))

test('byte LRU counts keys, replaces without drift and enforces count and byte caps', () => {
  const lru = new ByteLru(600, 2)
  lru.set('a', 'A', 100)
  lru.set('b', 'B', 100)
  assert.equal(lru.bytes, 460)
  assert.equal(lru.get('a'), 'A')
  lru.set('c', 'C', 100)
  assert.equal(lru.peek('b'), undefined)
  assert.equal(lru.peek('a'), 'A')
  lru.set('a', 'AA', 150)
  assert.equal(lru.bytes, 510)
  assert.equal(lru.size, 2)
  assert.equal(lru.set('huge', 'H', 1000), false)
  assert.ok(lru.bytes <= 600)
  assert.equal(lru.size, 2)
  lru.clear()
  assert.equal(lru.bytes, 0)
  assert.equal(lru.size, 0)
})

test('UTF-16 accounting includes non-ASCII keys and emoji', () => {
  assert.equal(textBytes('汉字😀'), 8)
  const lru = new ByteLru(200, 3)
  assert.equal(lru.set('汉字😀', '正文', 4), true)
  assert.equal(lru.bytes, 140)
})

test('LRU evicts least recently used content by byte budget and owner cleanup', () => {
  const lru = new ByteLru(700, 5)
  lru.set('a', 'A', 100, 't1')
  lru.set('b', 'B', 100, 't2')
  lru.set('c', 'C', 100, 't3')
  lru.get('a')
  lru.set('d', 'D', 100, 't1')
  assert.equal(lru.peek('b'), undefined)
  lru.retainOwners(new Set(['t1']))
  assert.equal(lru.size, 2)
  assert.equal(lru.bytes, 460)
})

test('body accounting includes tool results, errors, metadata and revision', () => {
  const cache = new BodyCache(4096, 5)
  const payload = { text: 'x'.repeat(800), process: [{ callId: 'c', name: 'shell', status: 'done', arguments: 'a'.repeat(300), result: 'r'.repeat(300), error: 'e'.repeat(300) }] }
  cache.set('a', 1, 'v', payload)
  assert.ok(cache.bytes > 3500)
  cache.set('a', 2, 'v', body('second'))
  assert.ok(cache.bytes <= 4096)
  assert.equal(cache.size, 1)
  assert.equal(cache.get('a', 1, 'v'), undefined)
  cache.clear()
  assert.equal(cache.bytes, 0)
})

test('body revisions invalidate stale tool process content and removed owners are released', () => {
  const cache = new BodyCache()
  cache.set('a', 1, 'pending', body('old'))
  assert.equal(cache.get('a', 1, 'done'), undefined)
  assert.equal(cache.size, 0)
  cache.set('a', 1, 'done', body('new'))
  cache.set('b', 1, 'v1', body('other'))
  cache.retainThreads(new Set(['b']))
  assert.equal(cache.size, 1)
  assert.equal(cache.get('b', 1, 'v1').text, 'other')
})

test('body and markdown caches plateau during thousands of inserts', () => {
  const bodies = new BodyCache(8000, 20)
  const markdown = new ByteLru(4000, 10)
  for (let seq = 0; seq < 5000; seq++) {
    bodies.set('a', seq, 'v1', body(`内容${seq}${'x'.repeat(200)}`))
    markdown.set(`key${seq}`, `html${seq}`, 500)
    assert.ok(bodies.bytes <= 8000)
    assert.ok(markdown.bytes <= 4000)
    assert.ok(bodies.size <= 20)
    assert.ok(markdown.size <= 10)
  }
})

test('loader single-flight and concurrency bound includes queued threads', async () => {
  const cache = new BodyCache()
  const calls = []
  const loader = new BodyLoader({ cache, request(path, signal) {
    const pending = deferred()
    calls.push({ path, signal, pending })
    return pending.promise
  } })
  const wanted = Array.from({ length: 60 }, (_, seq) => item(seq))
  loader.sync(wanted)
  loader.sync(wanted)
  assert.equal(calls.length, 2)
  assert.equal(loader.jobs.size, 2)
  assert.equal(selectors(calls[0].path).length, 20)
  calls[0].pending.resolve(response(selectors(calls[0].path)))
  await turn()
  assert.equal(calls.length, 3)
  assert.equal(loader.jobs.size, 2)
  for (const call of calls.slice(1)) call.pending.resolve(response(selectors(call.path)))
  await loader.idle()
  assert.equal(cache.size, 60)
  assert.equal(loader.jobs.size, 0)
  assert.equal(loader.failures.size, 0)
})

test('byte-limited response cursors cover a batch without fetching unrelated history', async () => {
  const cache = new BodyCache()
  const calls = []
  const loader = new BodyLoader({ cache, request: async path => {
    calls.push(path)
    const params = new URL(path, 'http://local').searchParams
    const seqs = selectors(path)
    const cursor = Number(params.get('cursor'))
    return { messages: { [seqs[cursor]]: body(`正文${seqs[cursor]}`) }, nextCursor: cursor + 1 < seqs.length ? cursor + 1 : null }
  } })
  loader.sync([item(42), item(43)])
  await loader.idle()
  assert.equal(calls.length, 2)
  assert.deepEqual(selectors(calls[1]), [42, 43])
  assert.equal(cache.get('a', 43, 'v1').text, '正文43')
})

test('leaving a page aborts its request and late responses cannot cache or render', async () => {
  const cache = new BodyCache()
  const calls = []
  let renders = 0
  const loader = new BodyLoader({ cache, onUpdate: () => { renders++ }, request(path, signal) {
    const pending = deferred()
    calls.push({ path, signal, pending })
    return pending.promise
  } })
  loader.sync([item(1)], 'page1')
  loader.sync([item(2)], 'page2')
  assert.equal(calls[0].signal.aborted, true)
  calls[0].pending.resolve(response([1]))
  await turn()
  assert.equal(cache.get('a', 1, 'v1'), undefined)
  assert.equal(renders, 0)
  calls[1].pending.resolve(response([2]))
  await loader.idle()
  assert.equal(cache.get('a', 2, 'v1').text, '正文2')
  assert.equal(renders, 1)
})

test('a late aborted finally does not clear a replacement request for the same sequence', async () => {
  const cache = new BodyCache()
  const calls = []
  const loader = new BodyLoader({ cache, request(path, signal) {
    const pending = deferred()
    calls.push({ path, signal, pending })
    return pending.promise
  } })
  loader.sync([item(1)])
  loader.pause()
  loader.sync([item(1)])
  calls[0].pending.reject(new Error('aborted'))
  await turn()
  loader.sync([item(1)])
  assert.equal(calls.length, 2)
  assert.equal(loader.jobs.size, 1)
  assert.equal(loader.failures.size, 0)
  calls[1].pending.resolve(response([1]))
  await loader.idle()
  assert.equal(cache.get('a', 1, 'v1').text, '正文1')
})

test('revision changes cancel stale process responses even for the same message', async () => {
  const cache = new BodyCache()
  const calls = []
  const loader = new BodyLoader({ cache, request: () => {
    const pending = deferred()
    calls.push(pending)
    return pending.promise
  } })
  loader.sync([item(1, 'a', 'pending')])
  loader.sync([item(1, 'a', 'done')])
  calls[0].resolve(response([1]))
  await turn()
  assert.equal(cache.size, 0)
  calls[1].resolve(response([1]))
  await loader.idle()
  assert.equal(cache.get('a', 1, 'done').text, '正文1')
})

test('retaining an archived thread set releases caches and cancels affected work', async () => {
  const cache = new BodyCache()
  cache.set('a', 0, 'v1', body('old'))
  const calls = []
  const loader = new BodyLoader({ cache, request(path, signal) {
    const pending = deferred()
    calls.push({ path, signal, pending })
    return pending.promise
  } })
  loader.sync([item(1), item(1, 'b')])
  loader.retainThreads(new Set(['b']))
  assert.equal(cache.get('a', 0, 'v1'), undefined)
  assert.equal(calls[0].signal.aborted, true)
  calls[0].pending.resolve(response([1]))
  calls[1].pending.resolve(response([1]))
  await loader.idle()
  assert.equal(cache.get('a', 1, 'v1'), undefined)
  assert.equal(cache.get('b', 1, 'v1').text, '正文1')
})

test('closing the map clears cache and request metadata; reopening loads again', async () => {
  const cache = new BodyCache()
  const calls = []
  let renders = 0
  const loader = new BodyLoader({ cache, onUpdate: () => { renders++ }, request(path, signal) {
    const pending = deferred()
    calls.push({ signal, pending })
    return pending.promise
  } })
  cache.set('a', 0, 'v1', body('cached'))
  loader.sync([item(1)])
  loader.pause({ clearCache: true })
  assert.equal(cache.bytes, 0)
  assert.equal(loader.jobs.size, 0)
  assert.equal(loader.wanted.size, 0)
  assert.equal(loader.attempted.size, 0)
  assert.equal(loader.failures.size, 0)
  assert.equal(calls[0].signal.aborted, true)
  calls[0].pending.resolve(response([1]))
  await turn()
  assert.equal(cache.size, 0)
  assert.equal(renders, 0)
  loader.sync([item(1)])
  calls[1].pending.resolve(response([1]))
  await loader.idle()
  assert.equal(cache.size, 1)
})

test('an oversized viewport stops re-fetching evicted visible bodies', async () => {
  const cache = new BodyCache(800, 1)
  let calls = 0
  const loader = new BodyLoader({ cache, request: async path => { calls++; return response(selectors(path)) } })
  const wanted = [item(1), item(2), item(3)]
  loader.sync(wanted)
  await loader.idle()
  for (let i = 0; i < 30; i++) { loader.sync(wanted); await loader.idle() }
  assert.equal(calls, 1)
  assert.equal(cache.size, 1)
  assert.equal(loader.unavailable('a', 1, 'v1'), true)
})

test('missing responses retry on another visit while failures remain screen-scoped', async () => {
  const cache = new BodyCache()
  let calls = 0
  const loader = new BodyLoader({ cache, request: async path => {
    calls++
    return calls === 1 ? { messages: {}, nextCursor: null } : response(selectors(path))
  } })
  loader.sync([item(1)], 'canvas')
  await loader.idle()
  assert.equal(loader.failures.has('a:1'), true)
  loader.sync([item(1)], 'canvas')
  await loader.idle()
  assert.equal(calls, 1)
  loader.sync([item(1)], 'detail')
  await loader.idle()
  assert.equal(calls, 2)
  assert.equal(loader.failures.size, 0)
  assert.equal(cache.size, 1)
})

test('changing views preserves a request still needed by the new view', async () => {
  const cache = new BodyCache()
  const pending = deferred()
  let calls = 0
  const loader = new BodyLoader({ cache, request: () => { calls++; return pending.promise } })
  loader.sync([item(1)], 'canvas')
  loader.sync([item(1)], 'inspector')
  assert.equal(calls, 1)
  pending.resolve(response([1]))
  await loader.idle()
  assert.equal(cache.size, 1)
})

test('wanted and failure metadata stay bounded even if an entire canvas is visible', async () => {
  const loader = new BodyLoader({ cache: new BodyCache(), request: async () => { throw new Error('offline') } })
  loader.sync(Array.from({ length: 10_000 }, (_, seq) => item(seq)))
  await loader.idle()
  assert.equal(loader.wanted.size, LIMITS.wanted)
  assert.equal(loader.attempted.size, LIMITS.wanted)
  assert.equal(loader.failures.size, LIMITS.wanted)
  loader.sync([])
  assert.equal(loader.attempted.size, 0)
  assert.equal(loader.failures.size, 0)
})

test('invalid cursors cannot create an unbounded paging loop', async () => {
  let calls = 0
  const loader = new BodyLoader({ cache: new BodyCache(), request: async () => { calls++; return { messages: {}, nextCursor: 0 } } })
  loader.sync([item(1)])
  await loader.idle()
  assert.equal(calls, 1)
  assert.equal(loader.failures.size, 1)
})
