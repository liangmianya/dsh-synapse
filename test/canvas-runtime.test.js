import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('uses one camera transform without browser scroll coordinates', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')

  assert.match(source, /canvasCamera: \{ x: 0, y: 0 \}/)
  assert.match(source, /translate\(\$\{state\.canvasCamera\.x\}px, \$\{state\.canvasCamera\.y\}px\) scale\(\$\{state\.zoom\}\)/)
  assert.doesNotMatch(source, /canvasScroll|canvasPadding|canvasDomShift|canvasMetrics|viewport\.scrollLeft|viewport\.scrollTop/)
})

test('reuses the live map iframe and retries initialization only after iframe load', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const openFlow = source.slice(source.indexOf('let mapOpenFallback'), source.indexOf('const onMessage'))
  const open = openFlow.slice(openFlow.indexOf('const open ='), openFlow.indexOf('const onFrameLoad'))

  assert.doesNotMatch(openFlow, /frame\.src\s*=/)
  assert.match(openFlow, /const onFrameLoad/)
  assert.match(openFlow, /if \(mapOpening\) send\('synapse:map-opened'\)/)
  assert.ok(open.indexOf('overlay.hidden = false') < open.indexOf("send('synapse:map-opened')"))
  assert.match(open, /overlay\.classList\.add\('is-opening'\)/)
})

test('recenters the canvas whenever the map view is reopened', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const mapOpened = source.slice(source.indexOf("if (data.type === 'synapse:map-opened')"), source.indexOf("if (data.type === 'synapse:workspaces')"))

  assert.match(mapOpened, /resetCanvasCamera\(\)/)
  assert.match(mapOpened, /state\.mode = 'canvas'\s+render\(\)/)
})

test('lets the card answer scroll with the native wheel instead of adding deltaY', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const wheel = source.slice(source.indexOf("app.addEventListener('wheel'"), source.indexOf("app.addEventListener('click'"))

  assert.match(wheel, /native wheel/)
  assert.doesNotMatch(wheel, /scrollTop\s*\+=/)
})

test('preserves each card answer scroll across canvas re-renders', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const render = source.slice(source.indexOf('function render() {'), source.indexOf('function renderPreservingDetailScroll'))

  assert.match(render, /cardScrollTops/)
  assert.match(render, /card\.dataset\.cardId/)
  assert.match(render, /\.thread-card\[data-card-id=/)
  assert.match(render, /\.thread-answer`\)\s*if \(answer instanceof HTMLElement\) answer\.scrollTop = scrollTop/)
})

test('activating a session from the map syncs DSH without closing the map', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const activate = source.slice(source.indexOf("'synapse:activate-session'"), source.indexOf("'synapse:fork-session'"))

  assert.match(activate, /ctx\.sessions\.open\(event\.data\.sessionId\)/)
  assert.doesNotMatch(activate, /close\(\)/)
})

test('selecting a session in the sidebar syncs the DSH current session', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const selectThread = source.slice(source.indexOf("button.dataset.action === 'select-thread'"), source.indexOf("button.dataset.action === 'show-thread'"))

  assert.match(selectThread, /synapse:activate-session/)
})

test('clicking a session card syncs the DSH current session', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const cardClick = source.slice(source.indexOf('if (!(button instanceof HTMLElement)) {'), source.indexOf("if (button.dataset.action === 'close')"))

  assert.match(cardClick, /thread\.dshSessionId !== null\) post\('synapse:activate-session'/)
})

test('switching the workspace in the map syncs DSH to its first session', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const select = source.slice(source.indexOf("app.addEventListener('change'"), source.indexOf("app.addEventListener('input'"))

  assert.match(select, /choice\.sessionIds\[0\]/)
  assert.match(select, /post\('synapse:activate-session'/)
})

test('renders markdown tables and allows higher canvas zoom', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const markdown = source.slice(source.indexOf('function markdownBlock'), source.indexOf('function overlapsCard'))

  assert.match(markdown, /<table><thead>/)
  assert.match(markdown, /isTableDelimiter/)
  assert.match(source, /Math\.min\(4,/)
})

test('renders the refactored detail view with role-based messages', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const thread = source.slice(source.indexOf('function renderThread'), source.indexOf('function render()'))
  const message = source.slice(source.indexOf('function threadMessage'), source.indexOf('function processRecords'))

  assert.match(thread, /detail-scroll/)
  assert.match(thread, /detail-head/)
  assert.match(message, /message-avatar/)
  assert.match(message, /message-body/)
})

test('persists dragged card positions and can focus the current session', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')

  assert.match(source, /localStorage\.setItem\(CARD_POSITIONS_KEY/)
  assert.match(source, /function focusActiveCard\(\)/)
  assert.match(source, /data-action="focus-active"/)
})

test('switching workspaces syncs DSH to the most recently updated session', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const select = source.slice(source.indexOf("app.addEventListener('change'"), source.indexOf("app.addEventListener('input'"))

  assert.match(select, /updatedAt/)
  assert.match(select, /post\('synapse:activate-session'/)
})

test('mirrors DSH theme changes into the map', async () => {
  const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8')

  assert.match(clientSource, /data-ds-dark-theme/)
  assert.match(clientSource, /synapse:theme/)
  assert.match(appSource, /data\.type === 'synapse:theme'/)
  assert.match(appSource, /document\.documentElement\.dataset\.theme/)
})

test('leaves text selections inside cards intact', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const cardClick = source.slice(source.indexOf('if (!(button instanceof HTMLElement)) {'), source.indexOf("if (button.dataset.action === 'close')"))

  assert.match(cardClick, /event\.detail > 1/)
  assert.match(cardClick, /Math\.hypot/)
  assert.match(source, /pointerDownPosition = \{ x: event\.clientX/)
})

test('caches markdown rendering and patches the live card without a full render', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const live = source.slice(source.indexOf('function scheduleLiveCardUpdate'), source.indexOf('async function pollProjection'))

  assert.match(source, /const markdownCache = new Map\(\)/)
  assert.match(source, /MARKDOWN_CACHE_LIMIT/)
  assert.match(source, /function scheduleLiveCardUpdate/)
  assert.match(live, /function applyLiveReplyToCard/)
  assert.match(live, /requestAnimationFrame/)
})

test('renders a follow-up plus on final cards and fold plus branch controls on non-final cards', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const card = source.slice(source.indexOf('function conversationCard'), source.indexOf('function draftActions'))

  assert.match(card, /class="graph-continue-button"/)
  assert.match(card, /data-action="open-continue"/)
  assert.match(card, /aria-label="添加追问"/)
  assert.match(card, /childCount === 0 \|\| card\.canContinue === true \? ''/)
  assert.match(card, /class="graph-fold-button/)
  assert.match(card, /data-action="toggle-card-children"/)
  assert.match(card, /aria-expanded=/)
  assert.match(card, /M3\.5 8h9/)
  assert.match(card, /M8 3\.5v9/)
  assert.match(card, /childCount === 0 \|\| card\.canContinue === true \|\| !Number\.isInteger\(card\.answer\?\.sourceSeq\)/)
  assert.match(card, /class="graph-branch-button"/)
  assert.match(card, /aria-label="在新对话中分支"/)
  assert.match(card, /M13\.0762 1\.37207C14\.0846/)
  assert.doesNotMatch(card, />追问<\/button>/)
  assert.doesNotMatch(card, />分支<\/button>/)
  assert.doesNotMatch(card, /class="branch-button"/)
})

test('positions the latest plus at the connector and the branch icon below the fold control', async () => {
  const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')

  assert.match(styles, /\.graph-continue-button, \.graph-fold-button \{ top: 50%; transform: translateY\(-50%\); \}/)
  assert.match(styles, /\.graph-branch-button \{ top: calc\(50% \+ 30px\); transform: translateY\(-50%\); \}/)
  assert.match(styles, /\.graph-continue-button svg, \.graph-fold-button svg, \.graph-branch-button svg/)
  assert.match(styles, /\[data-theme="dark"\] \.graph-continue-button, \[data-theme="dark"\] \.graph-fold-button, \[data-theme="dark"\] \.graph-branch-button/)
})

test('persists graph collapse choices and renders connectors from visible cards only', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const canvas = source.slice(source.indexOf('function renderCanvas'), source.indexOf('function isProcessMessage'))
  const toggle = source.slice(source.indexOf("button.dataset.action === 'toggle-card-children'"), source.indexOf("button.dataset.action === 'open-continue'"))

  assert.match(source, /COLLAPSED_CARDS_KEY/)
  assert.match(source, /localStorage\.setItem\(COLLAPSED_CARDS_KEY/)
  assert.match(canvas, /const graph = conversationGraphView\(allCards\)/)
  assert.match(canvas, /const cards = graph\.cards/)
  assert.match(canvas, /canvasConnectors\(cards\)/)
  assert.match(toggle, /state\.collapsedCardIds\.(?:has|delete|add)/)
  assert.match(toggle, /persistCollapsedCards\(\)/)
})

test('identifies when an anchored draft has no visible parent card', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const placement = source.slice(source.indexOf('function draftPlacement'), source.indexOf('function draftCard'))

  assert.match(placement, /draft\.anchorId === undefined/)
  assert.match(placement, /cards\.find\(card => card\.id === draft\.anchorId\)/)
  assert.match(placement, /if \(parent === undefined\) return null/)
})

test('prevents collapse from hiding drafts or the active conversation and restores focus', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const toggle = source.slice(source.indexOf("button.dataset.action === 'toggle-card-children'"), source.indexOf("button.dataset.action === 'open-continue'"))

  assert.match(toggle, /const visibleCards = conversationGraphView\(allCards, nextCollapsed\)\.cards/)
  assert.match(toggle, /draftPlacement\(allCards\)\?\.parent\.id/)
  assert.match(toggle, /请先完成或取消正在编辑的追问或分支/)
  assert.match(toggle, /当前会话位于这个后续分支中/)
  assert.match(toggle, /window\.setTimeout/)
  assert.match(toggle, /\.focus\(\)/)
})

test('reveals hidden ancestor paths when a conversation becomes current', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const reveal = source.slice(source.indexOf('function revealConversationThread'), source.indexOf('function canvasConnectors'))
  const current = source.slice(source.indexOf("data.type === 'synapse:current-session'"), source.indexOf("data.type === 'synapse:live-reply'"))

  assert.match(reveal, /state\.collapsedCardIds\.delete\(parentId\)/)
  assert.match(reveal, /persistCollapsedCards\(\)/)
  assert.match(current, /revealConversationThread\(conversationCards\(state\.workspace\.threads\), thread\.id\)/)
})

test('prunes persisted collapsed state when a conversation is archived', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const archive = source.slice(source.indexOf('async function archiveThread'), source.indexOf('function openContinue'))

  assert.match(archive, /state\.collapsedCardIds/)
  assert.match(archive, /key\.startsWith\(`\$\{id\}:`\)/)
  assert.match(archive, /persistCollapsedCards\(\)/)
})

test('layout button automatically repairs broken parent-child connections', async () => {
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8')

  // Button triggers connection repair before resetting positions and re-rendering
  assert.match(app, /if \(button\.dataset\.action === 'layout' && state\.workspace !== null\)/)
  assert.match(app, /await repairWorkspaceSessionConnections\(\)/)
  assert.match(app, /async function repairWorkspaceSessionConnections\(\)/)

  // Test the repair function logic with VM
  const vm = await import('node:vm')
  const context = {
    globalThis: {},
    state: {
      workspace: {
        id: 'w1',
        title: '工作区',
        threads: [
          { id: 'parent-1', title: '父会话', parentId: null, messages: [{ kind: 'user', text: '你好', sourceSeq: 1 }, { kind: 'assistant', text: '你好！', sourceSeq: 2 }] },
          { id: 'child-1', title: '子分支1', parentId: 'wrong-id', messages: [{ kind: 'user', text: '你好', sourceSeq: 1 }, { kind: 'assistant', text: '你好！', sourceSeq: 2 }, { kind: 'user', text: '分支1问题', sourceSeq: 3 }] },
          { id: 'child-2', title: '子分支2', parentId: null, messages: [{ kind: 'user', text: '你好', sourceSeq: 1 }, { kind: 'assistant', text: '你好！', sourceSeq: 2 }, { kind: 'user', text: '分支2问题', sourceSeq: 4 }] },
          { id: 'isolated-3', title: '独立话题', parentId: 'parent-1', messages: [{ kind: 'user', text: '今天天气', sourceSeq: 1 }, { kind: 'assistant', text: '晴天', sourceSeq: 2 }] },
        ],
      },
      cardPositions: new Map(),
      branchAnchors: new Map(),
    },
  }
  vm.createContext(context)

  const fnStart = app.indexOf('function normalizeTurnText')
  const fnEnd = app.indexOf('function persistCardPositions()')
  const fnCode = app.slice(fnStart, fnEnd)

  vm.runInContext(`${fnCode}; globalThis.repair = repairWorkspaceSessionConnections`, context)
  const changed = await context.globalThis.repair()

  assert.equal(changed, true)
  const threads = context.state.workspace.threads
  // child-1 repaired from wrong-id to parent-1 based on context prefix
  assert.equal(threads.find(t => t.id === 'child-1').parentId, 'parent-1')
  assert.equal(threads.find(t => t.id === 'child-1').sourceSeedLength, 3)
  assert.equal(context.state.branchAnchors.get('child-1'), 'parent-1:turn:1')

  // child-2 linked to parent-1 based on context prefix
  assert.equal(threads.find(t => t.id === 'child-2').parentId, 'parent-1')
  assert.equal(threads.find(t => t.id === 'child-2').sourceSeedLength, 4)
  assert.equal(context.state.branchAnchors.get('child-2'), 'parent-1:turn:1')

  // isolated-3 has no shared turns with parent-1 -> disconnected to root
  assert.equal(threads.find(t => t.id === 'isolated-3').parentId, null)
  assert.equal(threads.find(t => t.id === 'isolated-3').sourceSeedLength, null)
  assert.equal(context.state.branchAnchors.has('isolated-3'), false)
})

test('renders and persists card notes and opens context menu on right click', async () => {
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')

  // Context menu on right click
  assert.match(app, /app\.addEventListener\('contextmenu',/)
  assert.match(app, /renderContextMenu\(\)/)
  assert.match(styles, /\.synapse-context-menu/)

  // Card note persistence and display
  assert.match(app, /const CARD_NOTES_KEY = 'dsh-synapse:card-notes:v1'/)
  assert.match(app, /function rememberCardNote\(cardId, note\)/)
  assert.match(app, /function removeCardNote\(cardId\)/)
  assert.match(app, /class="thread-card-note"/)
  assert.match(styles, /\.thread-card-note/)

  // Note modal dialog
  assert.match(app, /function renderNoteModal\(\)/)
  assert.match(app, /data-note-form/)
  assert.match(styles, /\.note-modal/)
})

test('builds maximum spanning tree for multi-level deep branches and sibling forks', async () => {
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const vm = await import('node:vm')

  const context = {
    globalThis: {},
    state: {
      workspace: {
        id: 'w1',
        title: '工作区',
        threads: [
          {
            id: 'trunk',
            createdAt: '2026-01-01T00:00:00.000Z',
            parentId: null,
            messages: Array.from({ length: 15 }, (_, i) => ({ kind: 'user', text: `Q${i + 1}`, sourceSeq: (i + 1) * 2 - 1 })),
          },
          {
            id: 'branchA',
            createdAt: '2026-01-01T00:10:00.000Z',
            parentId: null,
            messages: [
              ...Array.from({ length: 10 }, (_, i) => ({ kind: 'user', text: `Q${i + 1}`, sourceSeq: (i + 1) * 2 - 1 })),
              ...Array.from({ length: 8 }, (_, i) => ({ kind: 'user', text: `QA${i + 11}`, sourceSeq: 100 + (i + 11) * 2 - 1 })),
            ],
          },
          {
            id: 'deepBranchB',
            createdAt: '2026-01-01T00:20:00.000Z',
            parentId: null,
            messages: [
              ...Array.from({ length: 10 }, (_, i) => ({ kind: 'user', text: `Q${i + 1}`, sourceSeq: (i + 1) * 2 - 1 })),
              ...Array.from({ length: 4 }, (_, i) => ({ kind: 'user', text: `QA${i + 11}`, sourceSeq: 100 + (i + 11) * 2 - 1 })),
              ...Array.from({ length: 6 }, (_, i) => ({ kind: 'user', text: `QB${i + 15}`, sourceSeq: 200 + (i + 15) * 2 - 1 })),
            ],
          },
          {
            id: 'siblingBranchC',
            createdAt: '2026-01-01T00:15:00.000Z',
            parentId: null,
            messages: [
              ...Array.from({ length: 10 }, (_, i) => ({ kind: 'user', text: `Q${i + 1}`, sourceSeq: (i + 1) * 2 - 1 })),
              ...Array.from({ length: 3 }, (_, i) => ({ kind: 'user', text: `QC${i + 11}`, sourceSeq: 300 + (i + 11) * 2 - 1 })),
            ],
          },
        ],
      },
      cardPositions: new Map(),
      branchAnchors: new Map(),
    },
  }
  vm.createContext(context)

  const fnStart = app.indexOf('function normalizeTurnText')
  const fnEnd = app.indexOf('function persistCardPositions()')
  const fnCode = app.slice(fnStart, fnEnd)

  vm.runInContext(`${fnCode}; globalThis.repair = repairWorkspaceSessionConnections`, context)
  await context.globalThis.repair()

  const threads = context.state.workspace.threads
  // trunk is root
  assert.equal(threads.find(t => t.id === 'trunk').parentId, null)

  // branchA forks from trunk at Turn 10 (sourceSeq: 19)
  assert.equal(threads.find(t => t.id === 'branchA').parentId, 'trunk')
  assert.equal(context.state.branchAnchors.get('branchA'), 'trunk:turn:19')
  assert.equal(threads.find(t => t.id === 'branchA').sourceSeedLength, 121)

  // deepBranchB forks from branchA at Turn 14 (QA14 -> sourceSeq: 127)
  assert.equal(threads.find(t => t.id === 'deepBranchB').parentId, 'branchA')
  assert.equal(context.state.branchAnchors.get('deepBranchB'), 'branchA:turn:127')
  assert.equal(threads.find(t => t.id === 'deepBranchB').sourceSeedLength, 229)

  // siblingBranchC forks from trunk at Turn 10 (sourceSeq: 19)
  assert.equal(threads.find(t => t.id === 'siblingBranchC').parentId, 'trunk')
  assert.equal(context.state.branchAnchors.get('siblingBranchC'), 'trunk:turn:19')
  assert.equal(threads.find(t => t.id === 'siblingBranchC').sourceSeedLength, 321)
})

test('renders canvas minimap navigator with interactive viewport bounding', async () => {
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')

  // Minimap structure and functions
  assert.match(app, /function renderMinimap/)
  assert.match(app, /function getMinimapMetrics/)
  assert.match(app, /function panCameraToMinimapPoint/)
  assert.match(app, /function updateMinimapViewfinder/)
  assert.match(app, /data-minimap-stage/)
  assert.match(app, /class="minimap-viewfinder"/)

  // Minimap styles
  assert.match(styles, /\.synapse-minimap/)
  assert.match(styles, /\.minimap-stage/)
  assert.match(styles, /\.minimap-viewfinder/)
  assert.match(styles, /\.minimap-node/)

  // Minimap pointer and toggle interactions
  assert.match(app, /data-minimap-stage/)
  assert.match(app, /data-action="toggle-minimap"/)
})
