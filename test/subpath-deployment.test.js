import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import vm from 'node:vm'

// Page-referenced assets only: the fixture below serves exactly this map, so a
// new <script>/<link> in page() fails the public-prefix check until it is here.
const sources = Object.fromEntries(await Promise.all(
  ['index.js', 'client.js', 'app.js', 'browser-cache.js', 'math.js', 'styles.css', 'deepseek-mark.svg',
    'vendor/katex/katex.min.js', 'vendor/katex/katex.min.css']
    .map(async name => [name, await readFile(new URL(`../${name}`, import.meta.url), 'utf8')]),
))
const between = (source, start, end) => {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert(from >= 0 && to > from, `Missing source markers: ${start}`)
  return source.slice(from, to)
}
const page = vm.runInNewContext(`(${between(sources['index.js'], 'function page()', '/** Mount Synapse routes')})`)()
const redirect = /path: '\/synapse', handler: ([^\n]+?) \}\), 'synapse: redirect'/.exec(sources['index.js'])
assert(redirect, 'Missing map redirect handler')
const redirectHandler = vm.runInNewContext(`(${redirect[1]})`)
const iframePath = /<iframe[^>]*\bsrc="([^"]+)"/.exec(sources['client.js'])?.[1]
const syncPath = /void fetch\('([^']+)'/.exec(sources['client.js'])?.[1]
const logoPath = /url\(['"]?([^'")]*deepseek-mark\.svg)['"]?\)/.exec(sources['styles.css'])?.[1]
assert(iframePath && syncPath && logoPath)
const apiSource = between(sources['app.js'], 'async function api(', 'function post(')

// Exercise the actual page, redirect, API wrapper and body loader behind an
// HTTP fixture that strips the public prefix exactly as proxy_pass .../ does.
// No DSH process or browser is needed and application startup is not executed.
for (const prefix of ['/', '/dsh/', '/tools/dsh/']) {
  test(`map entry, assets, redirect and API preserve public prefix ${prefix}`, async t => {
    const requests = []
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      if (!url.pathname.startsWith(prefix)) {
        res.writeHead(404)
        res.end('Request escaped the deployment prefix')
        return
      }
      const upstreamPath = `/${url.pathname.slice(prefix.length)}`
      requests.push({ publicPath: url.pathname, upstreamPath, method: req.method, query: url.searchParams })
      if (upstreamPath === '/synapse') return redirectHandler(req, res)
      if (upstreamPath === '/synapse/') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(page)
        return
      }
      const asset = upstreamPath.replace(/^\/synapse\//, '')
      if (Object.hasOwn(sources, asset) && asset !== 'index.js' && asset !== 'client.js') {
        res.writeHead(200)
        res.end(sources[asset])
        return
      }
      if (upstreamPath.startsWith('/synapse/api/')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        const seqs = url.searchParams.get('seqs')?.split(',') ?? []
        res.end(JSON.stringify({ ok: true, messages: Object.fromEntries(seqs.map(seq => [seq, { text: `full ${seq}` }])), nextCursor: null }))
        return
      }
      res.writeHead(404)
      res.end('Unknown upstream route')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const origin = `http://127.0.0.1:${server.address().port}`
    // The Host's <base href="./"> points to this public directory.
    const hostBase = `${origin}${prefix}`
    const mapUrl = new URL(iframePath, hostBase)
    assert.equal(mapUrl.pathname, `${prefix}synapse/`)
    const documentResponse = await fetch(mapUrl)
    assert.equal(documentResponse.status, 200)
    const html = await documentResponse.text()
    const basePath = /<base[^>]*href="([^"]+)"/.exec(html)?.[1] ?? './'
    const mapBase = new URL(basePath, documentResponse.url)
    for (const match of html.matchAll(/<(?:link|script)\b[^>]*(?:href|src)="([^"]+)"/g)) {
      const assetUrl = new URL(match[1], mapBase)
      assert(assetUrl.pathname.startsWith(`${prefix}synapse/`))
      assert.equal((await fetch(assetUrl)).status, 200, assetUrl.href)
    }
    const logoUrl = new URL(logoPath, new URL('styles.css', mapBase))
    assert.equal(logoUrl.pathname, `${prefix}synapse/deepseek-mark.svg`)
    assert.equal((await fetch(logoUrl)).status, 200)

    // Direct bookmarks without the trailing slash must not redirect to /synapse.
    const noSlash = new URL(mapUrl.href)
    noSlash.pathname = noSlash.pathname.slice(0, -1)
    const redirected = await fetch(noSlash)
    assert.equal(redirected.status, 200)
    assert.equal(redirected.url, mapUrl.href)

    const syncUrl = new URL(syncPath, hostBase)
    assert.equal(syncUrl.pathname, `${prefix}synapse/api/sessions/sync`)
    assert.equal((await fetch(syncUrl, { method: 'POST' })).status, 200)
    const context = vm.createContext({ URL, fetch, document: { baseURI: mapBase.href } })
    vm.runInContext(`${apiSource}\nglobalThis.mapApi = api`, context)
    for (const [path, options] of [
      ['/synapse/api/workspaces', {}],
      ['/synapse/api/threads/query', { method: 'POST', body: '{"sessionIds":[]}' }],
      ['/synapse/api/threads/thread-1', { method: 'DELETE' }],
      ['/synapse/api/threads/thread-1/branch', { method: 'POST', body: '{}' }],
    ]) {
      assert.equal((await context.mapApi(path, options)).ok, true)
      const last = requests.at(-1)
      assert.equal(last.publicPath, `${prefix}${path.slice(1)}`)
      assert.equal(last.upstreamPath, path)
      assert.equal(last.method, options.method ?? 'GET')
    }

    const cacheContext = vm.createContext({ AbortController })
    vm.runInContext(`${sources['browser-cache.js']}\nglobalThis.helpers = SynapseCache`, cacheContext)
    const { BodyCache, BodyLoader } = cacheContext.helpers
    const cache = new BodyCache()
    const loader = new BodyLoader({ cache, request: (path, signal) => context.mapApi(path, { signal }) })
    loader.sync([{ threadId: 'thread-1', seq: 42, revision: 'r' }], 'screen')
    await loader.idle()
    assert.equal(cache.get('thread-1', 42, 'r')?.text, 'full 42')
    const bodyRequest = requests.at(-1)
    assert.equal(bodyRequest.publicPath, `${prefix}synapse/api/threads/thread-1/full`)
    assert.equal(bodyRequest.upstreamPath, '/synapse/api/threads/thread-1/full')
    assert.equal(bodyRequest.query.get('seqs'), '42')
    assert.equal(bodyRequest.query.get('cursor'), '0')
  })
}
