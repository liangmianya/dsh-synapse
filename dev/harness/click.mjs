// Click-level smoke test for the map page.
//
// `pnpm test` exercises the Host half and slices of app.js, but it never
// renders the canvas: `test/morph-render.test.js` only matches the source text,
// so a regression in the DOM patching (controls collapsing, renders freezing,
// the view switch losing its cards) stays green there. This script closes that
// gap: it boots the real Host half on a real HTTP server, loads the real page
// in jsdom, and clicks the way a person does.
//
//   cd dev/harness && npm install && npm test
//   node click.mjs ../..            # test another checkout
//
// The iframe's own page is used, so `window.parent` is the same window and the
// postMessage bridge in client.js is not involved.
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'

const pluginDir = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..'))
const workDir = await mkdtemp(join(tmpdir(), 'synapse-harness-'))
const dataFile = join(workDir, 'workspaces.json')

const { apply, WorkspaceStore } = await import(pathToFileURL(join(pluginDir, 'index.js')).href)

/** Seed one workspace with two turns so the canvas has cards to click. */
async function seed() {
  const store = new WorkspaceStore(dataFile)
  const workspace = await store.create('复现用工作区')
  const thread = await store.createThread(workspace.id, { title: '演示会话', dshSessionId: null })
  await store.addMessage(thread.id, '第一个问题')
  await store.addMessage(thread.id, '第二个问题')
}

await seed()

const routes = []
apply({
  logger: { warn: () => {}, error: error => console.error('[host]', error) },
  webServer: { register: route => { routes.push(route); return () => {} } },
  sessions: { list: () => [] },
  on: () => () => {},
  effect: effect => effect(),
}, { dataFile, autoProjection: false })

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  const route = routes.find(item => item.kind === 'exact' ? item.path === path : path.startsWith(item.path))
  if (route === undefined) {
    response.writeHead(404)
    response.end()
    return
  }
  await route.handler(request, response)
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`

const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', error => console.error('[page]', error.message))

const dom = await JSDOM.fromURL(`${origin}/synapse/`, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    // jsdom ships no fetch; forward to Node's, resolved against the page origin.
    window.fetch = (input, init) => fetch(new URL(input, origin), init)
    if (window.CSS === undefined) window.CSS = {}
    if (typeof window.CSS.escape !== 'function') window.CSS.escape = value => String(value).replace(/["\\]/g, '\\$&')
    window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {}
    window.confirm = () => true
    // jsdom implements Range without layout; the selection pill asks for a box.
    const emptyBox = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    window.Range.prototype.getBoundingClientRect = () => emptyBox
    window.Range.prototype.getClientRects = () => []
  },
})

const { window } = dom
const document = window.document
const wait = ms => new Promise(done => setTimeout(done, ms))

/** Wait for a DOM condition, the way a person waits for the page to settle. */
async function until(check, label, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = check()
    if (value) return value
    await wait(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const failures = []
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Pointerdown, then click, on the same element. A missing target is a failure, not a crash. */
async function click(element, label) {
  if (element === null || element === undefined) {
    check(label, false, 'no such element')
    return
  }
  element.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 }))
  await wait(150)
}
const cardActions = card => [...card.querySelectorAll('button[data-action]')].map(button => button.dataset.action)
const cards = () => [...document.querySelectorAll('.thread-card[data-card-id]')]

await until(() => cards().length > 0, 'the canvas to render')

// 1. Every control of a card must survive the patch that follows the first
//    render. Sharing a thread id used to collapse 详情 / DSH / 归档 into one.
const footer = [...cards()[0].querySelectorAll('footer button')].map(button => button.dataset.action)
check('card footer keeps 详情 / DSH / 归档', footer.join(',') === 'show-thread,open-dsh,archive-thread', footer.join(','))

// 2. With a text selection on the page (the 追问 flow starts with one) the
//    shell used to stop patching, which looked like dead clicks everywhere.
const paragraph = document.querySelector('.thread-answer p') ?? document.querySelector('.thread-answer')
paragraph.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
window.getSelection()?.selectAllChildren?.(paragraph)
await click(cards()[0].querySelector('.thread-answer') ?? cards()[0], 'card body')
check('card click opens the inspector with a selection on the page', document.querySelector('.card-inspector') !== null)

// 3. A draft must be removable, otherwise `canReplaceView()` keeps refusing
//    every later render and the canvas looks frozen.
await click(document.querySelector('[data-action="create-session"]'), 'new session')
const draftOpened = document.querySelector('.draft-card') !== null
check('新会话 opens a draft', draftOpened)
await click(document.querySelector('[data-action="cancel-draft"]'), 'cancel draft')
check('取消 closes the draft', draftOpened && document.querySelector('.draft-card') === null)

// 4. Map and detail are two different views; switching must not eat the cards.
await click(document.querySelector('.thread-card[data-card-id] [data-action="show-thread"]'), 'detail button')
check('详情 opens the conversation', document.querySelector('.detail-scroll') !== null)
await click(document.querySelector('[data-action="show-canvas"]'), 'back to canvas')
check('返回画布 restores the cards', document.querySelector('.canvas-view') !== null && cards().length > 0, `${cards().length} cards`)

// 5. The toolbar must still act on the canvas it just restored.
await click(document.querySelector('[data-action="layout"]'), 'layout')
check('整理 keeps the cards mounted', cards().length > 0)

server.close()
dom.window.close()
await rm(workDir, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
