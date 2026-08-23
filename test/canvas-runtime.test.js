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
  const presence = source.slice(source.indexOf('function revealThreadPresence'), source.indexOf('function conversationCard(card, graph)'))
  const current = source.slice(source.indexOf("data.type === 'synapse:current-session'"), source.indexOf("data.type === 'synapse:live-reply'"))

  assert.match(reveal, /state\.collapsedCardIds\.delete\(parentId\)/)
  assert.match(reveal, /persistCollapsedCards\(\)/)
  assert.match(presence, /revealConversationThread\(allCards, threadId\)/)
  assert.match(presence, /state\.hiddenCardIds\.delete\(card\.id\)/)
  assert.match(presence, /persistHiddenCards\(\)/)
  assert.match(current, /revealThreadPresence\(thread\.id\)/)
})

test('prunes persisted collapsed state when a conversation is archived', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const archive = source.slice(source.indexOf('async function archiveThread'), source.indexOf('function openContinue'))

  assert.match(archive, /state\.collapsedCardIds/)
  assert.match(archive, /key\.startsWith\(`\$\{id\}:`\)/)
  assert.match(archive, /persistCollapsedCards\(\)/)
})

test('removing a turn from the map guards drafts and the last visible active card', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const hide = source.slice(source.indexOf("button.dataset.action === 'hide-card'"), source.indexOf("button.dataset.action === 'restore-card'"))

  assert.match(hide, /draftPlacement\(allCards\)\?\.parent\.id === cardId/)
  assert.match(hide, /请先完成或取消正在编辑的追问或分支/)
  assert.match(hide, /conversationGraphView\(allCards, state\.collapsedCardIds, nextHidden\)/)
  assert.match(hide, /当前会话在地图上的最后一个对话块不能移除/)
  assert.match(hide, /persistHiddenCards\(\)/)
})

test('removed turns can be restored individually or all at once from a panel', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const restore = source.slice(source.indexOf("button.dataset.action === 'restore-card'"), source.indexOf("button.dataset.action === 'zoom-in'"))

  assert.match(restore, /state\.hiddenCardIds\.delete\(button\.dataset\.card\)/)
  assert.match(restore, /state\.hiddenCardIds\.clear\(\)/)
  assert.match(restore, /state\.hiddenCardsOpen = !state\.hiddenCardsOpen/)
  assert.match(source, /class="hidden-cards-panel"/)
  assert.match(source, /data-action="restore-card"/)
  assert.match(source, /data-action="restore-all-hidden"/)
  assert.match(source, /HIDDEN_CARDS_KEY/)
  assert.match(source, /localStorage\.setItem\(HIDDEN_CARDS_KEY/)
  assert.match(source, />已移除 \$\{state\.hiddenCardIds\.size\}</)
})

test('drags the whole descendant subtree and re-mounts a branch head onto a dropped card', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const drag = source.slice(source.indexOf('function draggableSubtree'), source.indexOf('function canvasViewport'))

  assert.match(drag, /const childrenByParent = new Map\(\)/)
  assert.match(drag, /const ids = new Set\(\[cardId\]\)/)
  assert.match(drag, /pending\.pop\(\)/)
  assert.match(drag, /headCard\?\.turnIndex === 0/)
  assert.match(drag, /classList\.add\('drop-target'\)/)
  assert.match(drag, /classList\.remove\('drop-target'\)/)
  assert.match(drag, /rememberCardPosition\(id, position/)
  assert.match(drag, /method: 'PATCH'/)
  assert.match(drag, /parentId: targetCard\.dshThreadId, anchorSeq/)
  assert.match(drag, /rememberBranchAnchor\(thread\.id, targetCard\.id\)/)
})

test('a removed turn leaves the conversation intact and keeps the visible chain connected', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const graph = source.slice(source.indexOf('function conversationGraphView'), source.indexOf('function revealConversationThread'))

  assert.match(graph, /hiddenCardIds = state\.hiddenCardIds/)
  assert.match(graph, /effectiveParent/)
  assert.match(graph, /!hiddenCardIds\.has\(parentId\)/)
  assert.match(graph, /\.filter\(card => !hiddenCardIds\.has\(card\.id\)\)/)
})

test('empty canvas offers restoring every removed turn when nothing else is visible', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const canvas = source.slice(source.indexOf('function renderCanvas'), source.indexOf('function isProcessMessage'))

  assert.match(canvas, /cards\.length === 0 && state\.draft === null/)
  assert.match(canvas, /data-action="restore-all-hidden"/)
  assert.match(canvas, /画布上没有可见的对话块/)
})

test('fork anchors persist under the canvas thread id so re-mounted links survive reloads', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const branch = source.slice(source.indexOf("const session = await dshRpc('synapse:fork-session'"), source.indexOf("if (state.workspace !== null && !state.workspace.threads.some"))

  assert.match(branch, /rememberBranchAnchor\(result\.thread\.id, draft\.anchorId\)/)
})
