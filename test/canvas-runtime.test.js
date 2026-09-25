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

test('keeps the canvas viewport across dialog/map toggles and recenters on real session switches', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const mapOpened = source.slice(source.indexOf("if (data.type === 'synapse:map-opened')"), source.indexOf("if (data.type === 'synapse:workspaces')"))
  const currentSession = source.slice(source.indexOf("if (data.type === 'synapse:current-session')"), source.indexOf("if (data.type === 'synapse:live-reply'"))

  // Reopening the map for the same session must NOT reset the camera: only a
  // real session switch (current-session id change) re-centers the canvas.
  assert.doesNotMatch(mapOpened, /resetCanvasCamera\(\)/)
  assert.match(mapOpened, /state\.mode = 'canvas'\s+render\(\)/)
  assert.match(currentSession, /previousId !== data\.session\?\.id/)
  assert.match(currentSession, /focusActiveCard\(\)/)
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

  assert.match(activate, /ctx\.uiWorkspace\.openSession\(event\.data\.sessionId\)/)
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

  assert.match(cardClick, /post\('synapse:activate-session', \{ sessionId: thread\.dshSessionId \}\)/)
})

test('switching sessions from a map card keeps the current camera position', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const cardClick = source.slice(source.indexOf('if (!(button instanceof HTMLElement)) {'), source.indexOf("if (button.dataset.action === 'close')"))
  const currentSession = source.slice(source.indexOf("if (data.type === 'synapse:current-session')"), source.indexOf("if (data.type === 'synapse:live-reply'"))

  assert.match(cardClick, /mapCardSessionSwitches\.add\(thread\.dshSessionId\)/)
  assert.match(currentSession, /mapCardSessionSwitches\.delete\(data\.session\?\.id\)/)
  assert.match(currentSession, /openCurrentWorkspace\(\{ preserveCanvasCamera \}\)/)
  assert.match(currentSession, /if \(!preserveCanvasCamera\) focusActiveCard\(\)/)
})

test('keeps conversation highlighting separate from the exact selected card', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')
  const connectors = source.slice(source.indexOf('function canvasConnectors'), source.indexOf('function conversationCard(card, graph)'))
  const card = source.slice(source.indexOf('function conversationCard(card, graph)'), source.indexOf('function draftActions'))
  const cardClick = source.slice(source.indexOf('if (!(button instanceof HTMLElement)) {'), source.indexOf("if (button.dataset.action === 'close')"))
  const selectThread = source.slice(source.indexOf("button.dataset.action === 'select-thread'"), source.indexOf("button.dataset.action === 'show-thread'"))

  assert.match(source, /selectedCardId: null/)
  assert.match(card, /card\.id === state\.selectedCardId/)
  assert.doesNotMatch(card, /dshThreadId === state\.activeId/)
  assert.match(connectors, /card\.dshThreadId === state\.activeId && parent\.dshThreadId === state\.activeId/)
  assert.match(connectors, /active-connector/)
  assert.match(cardClick, /state\.selectedCardId = cardId/)
  assert.match(selectThread, /state\.selectedCardId = null/)
  assert.match(styles, /\.connectors path\.active-connector \{ stroke: #3478f6; \}/)
  assert.match(styles, /\[data-theme="dark"\] \.connectors path\.active-connector \{ stroke: #5b8def; \}/)
  assert.doesNotMatch(styles, /\.thread-card\.active/)
})

test('opens the clicked card in a tool-aware detail inspector', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')
  const cardClick = source.slice(source.indexOf('if (!(button instanceof HTMLElement)) {'), source.indexOf("if (button.dataset.action === 'close')"))
  const inspector = source.slice(source.indexOf('function messagesForCard'), source.indexOf('function renderThread'))

  assert.match(source, /inspectorCardId: null/)
  assert.match(source, /function openCardInspector/)
  assert.match(cardClick, /openCardInspector\(cardId\)/)
  assert.match(inspector, /function messagesForCard/)
  assert.match(inspector, /function inspectorProcessEntries/)
  assert.match(inspector, /processRecords\(process/)
  assert.doesNotMatch(inspector, /threadMessage\(thread, message\)/)
  assert.match(inspector, /class="card-inspector/)
  assert.match(inspector, /data-action="open-continue"/)
  assert.doesNotMatch(inspector, /完整对话/)
  assert.match(inspector, /<svg aria-hidden="true" viewBox="0 0 16 16">/)
  assert.match(inspector, /card\.canContinue === true/)
  assert.match(inspector, /card-inspector-error/)
  assert.match(source, /button\.dataset\.action === 'close-card-inspector'/)
  assert.match(source, /event\.key !== 'Escape'/)
  assert.match(source, /processCount/)
  assert.match(styles, /\.card-inspector \{ position: absolute/)
  assert.match(styles, /\.card-inspector\.is-opening, \.card-inspector\.is-closing/)
  assert.match(styles, /\.card-inspector-answer/)
  assert.doesNotMatch(styles, /\.card-inspector \{[^}]*box-shadow/)
  assert.match(styles, /\.card-inspector-actions button svg/)
  assert.doesNotMatch(styles, /\.card-inspector-head \{[^}]*border-bottom/)
  assert.match(styles, /\.card-inspector \{ top: auto; width: 100%/)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(styles, /\.thread-meta \.card-process-count/)
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

test('opens a prefilled follow-up draft from selected answer text', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const selection = source.slice(source.indexOf('function selectionFollowupTarget'), source.indexOf("app.addEventListener('pointerdown', event => {"))
  const click = source.slice(source.indexOf("if (button.dataset.action === 'follow-selection')"), source.indexOf("if (button.dataset.action === 'close')"))

  assert.match(source, /class="selection-followup"/)
  assert.match(selection, /\.thread-answer/)
  assert.match(selection, /\.message-assistant \.message-body/)
  assert.match(selection, /text === '' \|\| text\.length > 4000/)
  assert.match(selection, /text\.length > 4000/)
  assert.match(click, /openContinue\(thread, undefined, followup\.text\)/)
  assert.match(source, /state\.draft = \{ kind: 'continue', parentId: parent\.id, anchorId, text, sending: false \}/)
})

test('renders editable quick phrases in follow-up and branch drafts', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')

  assert.match(source, /DEFAULT_QUICK_PHRASES = \['展开说明', '举例', '通俗易懂', '对比解释'\]/)
  assert.match(source, /QUICK_PHRASES_KEY/)
  assert.match(source, /data-action="insert-quick-phrase"/)
  assert.match(source, /data-action="open-quick-phrase-editor"/)
  assert.match(source, /data-action="remove-quick-phrase"/)
  assert.match(source, /function insertQuickPhrase/)
  assert.match(source, /persistQuickPhrases\(\)/)
  assert.match(styles, /\.draft-quick-phrases/)
  assert.match(styles, /\[data-theme="dark"\] \.draft-quick-phrase/)
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
