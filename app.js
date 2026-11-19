const app = document.querySelector('#app')
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
const LEGACY_CARD_POSITIONS_KEY = 'dsh-synapse:card-positions'
const CARD_POSITIONS_KEY = 'dsh-synapse:card-positions:v3'
const COLLAPSED_CARDS_KEY = 'dsh-synapse:collapsed-cards:v1'
const QUICK_PHRASES_KEY = 'dsh-synapse:quick-phrases:v1'
const DEFAULT_QUICK_PHRASES = ['展开说明', '举例', '通俗易懂', '对比解释']
const MAX_QUICK_PHRASES = 12
const MAX_QUICK_PHRASE_LENGTH = 16
function normalizeQuickPhrases(value) {
  if (!Array.isArray(value)) return []
  const phrases = []
  for (const item of value) {
    const phrase = typeof item === 'string' ? item.trim().slice(0, MAX_QUICK_PHRASE_LENGTH) : ''
    if (phrase !== '' && !phrases.includes(phrase)) phrases.push(phrase)
    if (phrases.length === MAX_QUICK_PHRASES) break
  }
  return phrases
}
const savedQuickPhrases = (() => {
  try {
    const stored = localStorage.getItem(QUICK_PHRASES_KEY)
    return stored === null ? DEFAULT_QUICK_PHRASES : normalizeQuickPhrases(JSON.parse(stored))
  } catch { return DEFAULT_QUICK_PHRASES }
})()
const savedBranchAnchors = (() => {
  try {
    const value = JSON.parse(localStorage.getItem('dsh-synapse:branch-anchors') ?? '[]')
    return Array.isArray(value) ? value.filter(item => Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') : []
  } catch { return [] }
})()
const savedCardPositions = (() => {
  try {
    // Drop formats that were never persisted; the current key stores drags.
    localStorage.removeItem(LEGACY_CARD_POSITIONS_KEY)
    localStorage.removeItem('dsh-synapse:card-positions:v2')
    const value = JSON.parse(localStorage.getItem(CARD_POSITIONS_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter(item => Array.isArray(item) && typeof item[0] === 'string' && item[1] !== null && Number.isFinite(item[1].x) && Number.isFinite(item[1].y)) : []
  } catch { return [] }
})()
const savedCollapsedCards = (() => {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSED_CARDS_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
  } catch { return [] }
})()
const CARD_WIDTH = 310
const CARD_HEIGHT = 276
const CARD_GAP_Y = 42
const CAMERA_INSET_X = 56
const CAMERA_INSET_Y = 56
// Fixed world-space margins do not expand to most of the map at 20% zoom.
const REGION_MARGIN = 360
const REGION_PREFETCH_MARGIN = 900
const REGION_TICK_MS = 90
const MAP_DETAIL_CARDS = 80
const MAP_OVERVIEW_CARDS = 320
const MAP_FACE_TEXT = 2400
const OVERVIEW_ZOOM = .55
const DETAIL_PAGE_MESSAGES = 40
const state = {
  summaries: [], workspace: null, activeId: null, selectedCardId: null, mode: 'canvas', zoom: 1, currentDsh: null, sidebarCollapsed: false,
  dshWorkspaces: [], selectedDshWorkspaceId: null,
  historyBySession: new Map(), historyRequests: new Map(), pendingReplies: new Map(), pendingRpc: new Map(), liveReplies: new Map(),
  // Message bodies are not part of the workspace payload; they are fetched per
  // screenful and cached here (issue #42).
  bodyFailures: new Set(), mapVisible: window.parent === window,
  archivedSessionIds: new Set(),
  draft: null, error: '', workspaceLoad: 0, workspaceLoadOwner: null, workspaceLoadBusy: false, workspaceFingerprint: null, workspaceSummariesSignature: null, workspaceDshSignature: null, workspacesSignature: null, branchAnchors: new Map(savedBranchAnchors), cardPositions: new Map(savedCardPositions), collapsedCardIds: new Set(savedCollapsedCards), quickPhrases: savedQuickPhrases, quickPhraseEditorOpen: false,
  dragging: false, canvasGesture: false, canvasRefreshAfter: 0, canvasViewInitialized: false, canvasCamera: { x: 0, y: 0 }, mapCardSessionSwitches: new Set(),
  expandedMessageIds: new Set(),
  canvasCards: undefined, canvasCardsById: undefined, canvasGraph: undefined, mountedCardIds: new Set(), canvasNeedsCenter: false,
  detailScrollByThread: new Map(), detailThreadId: null, detailTargetCardId: null, detailPageByThread: new Map(),
  inspectorCardId: null, inspectorOpening: false, inspectorScrollByCard: new Map(),
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const formatTime = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const currentThread = () => state.workspace?.threads.find(thread => thread.id === state.activeId) ?? state.workspace?.threads[0] ?? null
const threadListTitle = thread => thread.dshSessionTitle ?? thread.title ?? questionFor(thread)

const bodyCache = new SynapseCache.BodyCache()
const bodyLoader = new SynapseCache.BodyLoader({
  cache: bodyCache,
  request: (path, signal) => api(path, { signal }),
  onUpdate: entries => {
    if (!state.mapVisible || document.hidden) return
    if (state.mode === 'thread') render()
    else refreshLoadedBodies(entries)
  },
})
state.bodyFailures = bodyLoader.failures
let cacheWorkspaceId = null
let cacheThreadIds = new Set()

function bodyRevision(message) {
  // Source messages are immutable; tools may finish or be added afterward.
  // Use only projection metadata, never hydrated arguments/results.
  return message.bodyRevision ?? JSON.stringify([
    message.text, message.length, message.kind, message.at,
    (message.process ?? []).slice(0, 12).map(entry => [entry.callId, entry.name, entry.status]),
    message.process?.length ?? 0,
  ])
}

function hydratedMessage(thread, message) {
  if (message === null || message === undefined) return message
  const revision = bodyRevision(message)
  const body = bodyCache.get(thread.id, message.sourceSeq, revision)
  return body === undefined ? message : { ...message, ...body, bodyRevision: revision, hydrated: true }
}

function hydratedCard(card) {
  const thread = canvasGraphCache?.threadById.get(card.dshThreadId) ?? state.workspace?.threads.find(item => item.id === card.dshThreadId)
  if (thread === undefined) return card
  const question = hydratedMessage(thread, card.questionMessage)
  return { ...card, question: question?.text ?? card.question, questionMessage: question,
    answer: hydratedMessage(thread, card.answer), error: hydratedMessage(thread, card.error) }
}

function clearViewCaches() {
  cancelRegionWork()
  invalidateCanvasGraph()
  bodyLoader.pause({ clearCache: true })
  markdownCache.clear()
  state.canvasCards = undefined
  state.canvasCardsById = undefined
  state.canvasGraph = undefined
  canvasGraphCache = null
  regionView = null
  regionElements.clear()
  state.mountedCardIds.clear()
  connectorPathsByCard.clear()
}

function prepareWorkspaceCaches(id) {
  if (state.workspace?.id === id) return
  clearViewCaches()
}

function pruneWorkspaceCaches() {
  invalidateCanvasGraph()
  const threads = visibleThreads(state.workspace?.threads ?? [])
  const ids = new Set(threads.map(thread => thread.id))
  const sessions = new Set(threads.map(thread => thread.dshSessionId))
  const switched = cacheWorkspaceId !== (state.workspace?.id ?? null)
  const removed = switched || [...cacheThreadIds].some(id => !ids.has(id))
  const belongs = key => ids.has(key.slice(0, key.indexOf(':')))
  if (switched) clearViewCaches()
  else bodyLoader.retainThreads(ids)
  if (removed) {
    markdownCache.clear()
    for (const key of state.expandedMessageIds) if (switched || !belongs(key)) state.expandedMessageIds.delete(key)
    for (const map of [state.detailScrollByThread, state.detailPageByThread]) {
      for (const key of map.keys()) if (switched || !ids.has(key)) map.delete(key)
    }
    for (const key of state.inspectorScrollByCard.keys()) if (switched || !belongs(key)) state.inspectorScrollByCard.delete(key)
    state.canvasCards = undefined
    state.canvasCardsById = undefined
    state.canvasGraph = undefined
    state.mountedCardIds.clear()
    connectorPathsByCard.clear()
    if (switched) {
      state.inspectorCardId = null; state.inspectorOpening = false; state.detailThreadId = null
    }
  }
  for (const map of [state.historyBySession, state.liveReplies]) for (const id of map.keys()) if (!sessions.has(id)) map.delete(id)
  cacheWorkspaceId = state.workspace?.id ?? null
  cacheThreadIds = ids
}

function pauseMapBodies() {
  state.mapVisible = false
  clearViewCaches()
  state.liveReplies.clear()
  hideSelectionFollowup()
  releaseRenderedBodies()
}

function releaseRenderedBodies() {
  // An iframe hidden by the host still retains its DOM. Drop the content,
  // keeping the viewport shell so camera measurements work on reopening.
  document.querySelector('.canvas-viewport')?.replaceChildren()
  document.querySelector('.detail-scroll')?.replaceChildren()
  document.querySelector('.card-inspector')?.remove()
}

function rememberBranchAnchor(sessionId, cardId) {
  invalidateCanvasGraph()
  state.branchAnchors.set(sessionId, cardId)
  try { localStorage.setItem('dsh-synapse:branch-anchors', JSON.stringify([...state.branchAnchors])) } catch { /* Private browsing may disable local storage. */ }
}

function persistCardPositions() {
  try { localStorage.setItem(CARD_POSITIONS_KEY, JSON.stringify([...state.cardPositions])) } catch { /* Private browsing may disable local storage. */ }
}

function persistCollapsedCards() {
  invalidateCanvasGraph()
  try { localStorage.setItem(COLLAPSED_CARDS_KEY, JSON.stringify([...state.collapsedCardIds])) } catch { /* Private browsing may disable local storage. */ }
}

function persistQuickPhrases() {
  try { localStorage.setItem(QUICK_PHRASES_KEY, JSON.stringify(state.quickPhrases)) } catch { /* Private browsing may disable local storage. */ }
}

function rememberCardPosition(cardId, position, aliases = []) {
  state.cardPositions.set(cardId, { x: Math.round(position.x), y: Math.round(position.y) })
  for (const alias of aliases) state.cardPositions.set(alias, { x: Math.round(position.x), y: Math.round(position.y) })
  persistCardPositions()
}

function resetCardPositions() {
  invalidateCanvasGraph()
  state.cardPositions.clear()
  persistCardPositions()
  try {
    localStorage.removeItem(LEGACY_CARD_POSITIONS_KEY)
    localStorage.removeItem('dsh-synapse:card-positions:v2')
  } catch { /* Private browsing may disable local storage. */ }
}

function resetCanvasCamera() {
  state.canvasViewInitialized = false
  state.canvasCamera = { x: 0, y: 0 }
}

async function api(path, options = {}) {
  // Call sites use the server's logical /synapse namespace. Resolve requests
  // inside this map document so a prefix-stripping proxy keeps its public path.
  const url = new URL(path.replace(/^\/synapse\//, ''), document.baseURI)
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(body.error ?? '请求失败'), { status: response.status })
  return body
}

function post(type, payload = {}) {
  if (window.parent !== window) window.parent.postMessage({ source: 'dsh-synapse', type, ...payload }, window.location.origin)
}

function dshRpc(type, payload = {}) {
  if (window.parent === window) return Promise.reject(new Error('请从 DSH 页面打开 Synapse 后再操作会话'))
  const requestId = crypto.randomUUID()
  post(type, { requestId, ...payload })
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      state.pendingRpc.delete(requestId)
      reject(new Error('DSH 未在规定时间内响应'))
    }, 20_000)
    state.pendingRpc.set(requestId, { resolve, reject, timer })
  })
}

function settleRpc(requestId, value, error) {
  const pending = state.pendingRpc.get(requestId)
  if (pending === undefined) return
  state.pendingRpc.delete(requestId)
  window.clearTimeout(pending.timer)
  if (error === undefined) pending.resolve(value)
  else pending.reject(error instanceof Error ? error : new Error(String(error)))
}

function setError(error = '') { state.error = error instanceof Error ? error.message : error; render() }

function messagesFromEvents(events) {
  if (!Array.isArray(events)) return []
  return events.flatMap(event => {
    const content = event?.data?.message?.content ?? event?.data?.content
    const text = Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).filter(Boolean).join('\n') : ''
    const sourceKind = event?.data?.source?.kind
    const injected = typeof sourceKind === 'string' ? sourceKind !== 'user'
      : text.trimStart().startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')
    if (event?.type === 'user/message' && text.trim() && !injected) return [{ kind: 'user', text, at: event.time, sourceSeq: event.seq, ...(typeof sourceKind === 'string' ? { sourceKind } : {}) }]
    if (event?.type === 'assistant/message') return [{ kind: 'assistant', text, at: event.time, sourceSeq: event.seq, turn: event.data?.turn, step: event.data?.step }]
    return []
  })
}

async function loadThreadHistory() {}

function canReplaceView() {
  return state.draft === null && !state.dragging && !state.canvasGesture && Date.now() >= state.canvasRefreshAfter && !document.activeElement?.matches('textarea')
}

function deferCanvasRefresh(delay = 700) {
  state.canvasRefreshAfter = Math.max(state.canvasRefreshAfter, Date.now() + delay)
}

function currentDshWorkspace() {
  const id = state.currentDsh?.id
  return typeof id === 'string' ? state.dshWorkspaces.find(workspace => workspace.sessionIds.includes(id)) : undefined
}

function selectedDshWorkspace() {
  return state.dshWorkspaces.find(workspace => workspace.id === state.selectedDshWorkspaceId)
}

function currentDshThread(threads = state.workspace?.threads ?? []) {
  const id = state.currentDsh?.id
  return typeof id === 'string' ? threads.find(thread => thread.dshSessionId === id) : undefined
}

/** Only the session fields the canvas actually draws; used to skip no-op renders. */
function sessionSignature(session) {
  if (session === null || session === undefined) return ''
  return [session.id ?? '', session.title ?? session.displayTitle ?? '', session.cwd ?? '', session.running === true ? '1' : '0'].join('|')
}

function workspaceChoices() {
  if (state.dshWorkspaces.length > 0) return state.dshWorkspaces.map(workspace => ({ ...workspace, source: 'dsh' }))
  return state.summaries.map(workspace => ({ id: workspace.id, title: workspace.title, path: workspace.cwd, sessionIds: [], source: 'projection' }))
}

async function threadsForDshWorkspace(workspace) {
  if (workspace.sessionIds.length === 0) return []
  // Stay within the API's 32 KiB request limit even for large DSH groups.
  // These batches contain selectors only, never unrelated workspace payloads.
  const batches = []
  const encoder = new TextEncoder()
  let batch = []
  let bytes = encoder.encode('{"sessionIds":[]}').length
  for (const id of new Set(workspace.sessionIds)) {
    const size = encoder.encode(JSON.stringify(id)).length + 1
    if (bytes + size > 32 * 1024) {
      if (batch.length === 0) throw new Error('会话编号过长')
      batches.push(batch)
      batch = []
      bytes = encoder.encode('{"sessionIds":[]}').length
    }
    if (bytes + size > 32 * 1024) throw new Error('会话编号过长')
    batch.push(id)
    bytes += size
  }
  if (batch.length > 0) batches.push(batch)
  const threads = []
  for (const sessionIds of batches) {
    const body = await api('/synapse/api/threads/query', { method: 'POST', body: JSON.stringify({ sessionIds }) })
    threads.push(...body.threads)
  }
  return threads
}

function dshWorkspaceProjection(workspace, threads) {
  return { id: `dsh:${workspace.id}`, title: workspace.title, cwd: workspace.path, threads }
}

async function openDshWorkspace(id, { renderAfter = true, preserveCanvasCamera = false, userInitiated = false } = {}) {
  const workspace = state.dshWorkspaces.find(item => item.id === id)
  if (workspace === undefined) return false
  // A background poll must never cancel or pre-empt a workspace the user just
  // picked, and two polls must never run at once: the 1s poll used to open a
  // fresh whole-workspace load every tick, each one cancelling the previous
  // ticket, so nothing ever rendered (16 loads / 12 cancellations in 19s).
  if (!userInitiated && (state.workspaceLoadOwner === 'user' || state.workspaceLoadBusy)) return false
  const load = ++state.workspaceLoad
  if (userInitiated) state.workspaceLoadOwner = 'user'
  state.workspaceLoadBusy = true
  prepareWorkspaceCaches(`dsh:${id}`)
  try {
    state.selectedDshWorkspaceId = id
    const summariesSignature = JSON.stringify(state.summaries)
    const threads = await threadsForDshWorkspace(workspace)
    if (load !== state.workspaceLoad || workspace !== selectedDshWorkspace()) return false
    const nextWorkspaceId = `dsh:${workspace.id}`
    if (state.workspace?.id !== nextWorkspaceId && !preserveCanvasCamera) resetCanvasCamera()
    state.workspace = dshWorkspaceProjection(workspace, threads)
    pruneWorkspaceCaches()
    state.workspaceFingerprint = JSON.stringify(state.workspace)
    state.workspaceSummariesSignature = summariesSignature
    state.workspaceDshSignature = JSON.stringify(workspace)
    const currentThread = currentDshThread(state.workspace.threads)
    state.activeId = currentThread?.id ?? (state.workspace.threads.some(thread => thread.id === state.activeId) ? state.activeId : state.workspace.threads[0]?.id ?? null)
    if (currentThread !== undefined) revealConversationThread(conversationCards(state.workspace.threads), currentThread.id)
    if (renderAfter && canReplaceView()) render()
    await Promise.all(state.workspace.threads.map(thread => loadThreadHistory(thread, false)))
    if (renderAfter && load === state.workspaceLoad && canReplaceView()) render()
    // After a user switch, bring that workspace's active conversation on screen.
    if (userInitiated && load === state.workspaceLoad) window.requestAnimationFrame(() => { if (state.mode === 'canvas') focusActiveCard() })
    return true
  } finally {
    if (load === state.workspaceLoad) {
      state.workspaceLoadOwner = null
      state.workspaceLoadBusy = false
      void hydrateBodies()
    }
  }
}

async function openCurrentWorkspace({ preserveCanvasCamera = false } = {}) {
  const workspace = currentDshWorkspace()
  if (workspace === undefined || workspace.id === state.selectedDshWorkspaceId) return false
  return openDshWorkspace(workspace.id, { preserveCanvasCamera })
}

async function refreshSummaries({ renderAfter = true, loadWorkspace = true } = {}) {
  const before = JSON.stringify(state.summaries)
  const body = await api('/synapse/api/workspaces')
  state.summaries = body.workspaces
  const changed = before !== JSON.stringify(state.summaries)
  if (!loadWorkspace) return changed
  const current = state.workspace?.id
  if (state.selectedDshWorkspaceId === null && current !== null && !state.summaries.some(item => item.id === current)) { state.workspace = null; pruneWorkspaceCaches() }
  const selected = selectedDshWorkspace()
  if (selected !== undefined && (changed || state.workspace === null)) await openDshWorkspace(selected.id, { renderAfter })
  else if (state.workspace === null && state.summaries.length > 0) await openWorkspace(state.summaries[0].id)
  else if (renderAfter && changed && canReplaceView()) render()
  return changed
}

async function openWorkspace(id, { renderAfter = true } = {}) {
  const load = ++state.workspaceLoad
  state.workspaceLoadBusy = true
  prepareWorkspaceCaches(id)
  try {
    const summariesSignature = JSON.stringify(state.summaries)
    const body = await api(`/synapse/api/workspaces/${id}`)
    if (load !== state.workspaceLoad) return
    if (state.workspace?.id !== body.workspace.id) resetCanvasCamera()
    state.workspace = body.workspace
    pruneWorkspaceCaches()
    state.workspaceFingerprint = JSON.stringify(state.workspace)
    state.workspaceSummariesSignature = summariesSignature
    state.activeId = state.workspace.threads.some(thread => thread.id === state.activeId) ? state.activeId : state.workspace.threads[0]?.id ?? null
    if (renderAfter && canReplaceView()) render()
    await Promise.all(state.workspace.threads.map(thread => loadThreadHistory(thread, false)))
    if (renderAfter && load === state.workspaceLoad && canReplaceView()) render()
  } finally {
    if (load === state.workspaceLoad) {
      state.workspaceLoadOwner = null
      state.workspaceLoadBusy = false
      void hydrateBodies()
    }
  }
}

/**
 * Quiet refresh of the workspace already on screen: re-fetch its payload and only
 * rebuild the canvas when the payload really changed. The poll used to call
 * `openDshWorkspace` every second, which re-ran the whole load (and its ticket)
 * just to discover nothing had changed.
 */
async function refreshCurrentWorkspace() {
  const current = state.workspace
  if (current === null || state.workspaceLoadBusy || state.workspaceLoadOwner === 'user') return false
  const load = state.workspaceLoad
  const selected = selectedDshWorkspace()
  const summariesSignature = JSON.stringify(state.summaries)
  const workspace = current.id.startsWith('dsh:')
    ? (selected === undefined ? null : dshWorkspaceProjection(selected, await threadsForDshWorkspace(selected)))
    : (await api(`/synapse/api/workspaces/${current.id}`)).workspace
  if (workspace === null || state.workspace !== current || load !== state.workspaceLoad || state.workspaceLoadBusy || selected !== selectedDshWorkspace() || !canReplaceView()) return false
  // A failed fetch never advances this signature: the next poll must retry
  // even if the server's summaries have stopped changing.
  state.workspaceSummariesSignature = summariesSignature
  state.workspaceDshSignature = JSON.stringify(selected)
  const fingerprint = JSON.stringify(workspace)
  if (state.workspaceFingerprint === fingerprint) return false
  state.workspaceFingerprint = fingerprint
  state.workspace = workspace
  pruneWorkspaceCaches()
  if (!state.workspace.threads.some(thread => thread.id === state.activeId)) {
    state.activeId = state.workspace.threads[0]?.id ?? null
  }
  if (canReplaceView()) render()
  return true
}

async function refreshProjection() {
  if (state.workspaceLoadBusy || state.workspaceLoadOwner === 'user') return false
  const summariesChanged = await refreshSummaries({ renderAfter: false, loadWorkspace: false })
  if (state.workspaceLoadBusy || state.workspaceLoadOwner === 'user' || !canReplaceView()) return false
  const selected = selectedDshWorkspace()
  let viewRemoved = false
  if ((state.selectedDshWorkspaceId !== null && selected === undefined) ||
      (state.selectedDshWorkspaceId === null && state.workspace !== null && !state.summaries.some(item => item.id === state.workspace.id))) {
    state.selectedDshWorkspaceId = null
    state.workspace = null
    pruneWorkspaceCaches()
    state.activeId = null
    viewRemoved = true
  }
  if (state.workspace === null || (selected !== undefined && state.workspace.id !== `dsh:${selected.id}`)) {
    const next = selected ?? currentDshWorkspace() ?? state.dshWorkspaces[0]
    if (next !== undefined) return openDshWorkspace(next.id)
    if (state.summaries.length > 0) { await openWorkspace(state.summaries[0].id); return true }
    if (summariesChanged || viewRemoved) render()
    return summariesChanged || viewRemoved
  }
  if (state.workspaceSummariesSignature !== JSON.stringify(state.summaries) ||
      (selected !== undefined && state.workspaceDshSignature !== JSON.stringify(selected))) return refreshCurrentWorkspace()
  if (summariesChanged) render()
  return summariesChanged
}

function openNewSession() {
  if (state.draft !== null) return
  state.mode = 'canvas'
  state.activeId = null
  state.selectedCardId = null
  state.inspectorCardId = null
  state.inspectorOpening = false
  state.quickPhraseEditorOpen = false
  state.draft = { kind: 'new', text: '', sending: false }
  state.error = ''
  resetCanvasCamera()
  render()
  window.setTimeout(() => document.querySelector('[data-draft] textarea')?.focus(), 0)
}

async function archiveThread(thread) {
  // A DSH-backed thread is archived in DSH itself, so the sidebar and this map
  // share one archive set (issue #21 / #19). Keeping a second local delete is
  // what made the map claim "archived" while DSH still listed the session.
  if (thread.dshSessionId !== null) {
    if (!window.confirm(`在 DSH 中归档「${thread.title}」及其分支？DSH 侧会话也会被归档。`)) return
    try {
      await dshRpc('synapse:archive-session', { sessionId: thread.dshSessionId })
    } catch (error) {
      setError(error instanceof Error ? error.message : '归档失败')
      return
    }
    state.archivedSessionIds.add(thread.dshSessionId)
    pruneWorkspaceCaches()
    state.activeId = state.activeId === thread.id ? (state.workspace?.threads.find(item => item.id !== thread.id)?.id ?? null) : state.activeId
    if (state.inspectorCardId !== null && state.canvasCardsById?.get(state.inspectorCardId)?.dshThreadId === thread.id) state.inspectorCardId = null
    render()
    await refreshSummaries()
    return
  }
  if (!window.confirm(`归档画布中的「${thread.title}」及其分支？DSH 原会话会保留，可在 DSH 内继续查看。`)) return
  await api(`/synapse/api/threads/${thread.id}`, { method: 'DELETE' })
  state.historyBySession.delete(thread.dshSessionId)
  state.detailScrollByThread.delete(thread.id)
  state.detailTargetCardId = state.detailThreadId === thread.id ? null : state.detailTargetCardId
  if (state.workspace !== null) {
    const removed = new Set([thread.id])
    for (let changed = true; changed;) {
      changed = false
      for (const item of state.workspace.threads) {
        if (item.parentId !== null && removed.has(item.parentId) && !removed.has(item.id)) {
          removed.add(item.id)
          changed = true
        }
      }
    }
    state.workspace.threads = state.workspace.threads.filter(item => !removed.has(item.id))
    pruneWorkspaceCaches()
    for (const key of [...state.cardPositions.keys()]) {
      if ([...removed].some(id => key.startsWith(`${id}:`))) state.cardPositions.delete(key)
    }
    let collapsedChanged = false
    for (const key of [...state.collapsedCardIds]) {
      if ([...removed].some(id => key.startsWith(`${id}:`))) {
        state.collapsedCardIds.delete(key)
        collapsedChanged = true
      }
    }
    if (collapsedChanged) persistCollapsedCards()
    state.activeId = state.activeId !== null && state.workspace.threads.some(item => item.id === state.activeId)
      ? state.activeId
      : state.workspace.threads[0]?.id ?? null
    render()
  } else {
    state.activeId = null
  }
  await refreshSummaries()
}

function focusDraftInput() {
  const input = document.querySelector('[data-draft] textarea')
  if (!(input instanceof HTMLTextAreaElement)) return
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}

function openContinue(parent, anchorId = undefined, text = '') {
  if (parent.dshSessionId === null) return setError('该节点没有关联的 DSH 会话')
  state.activeId = parent.id
  state.quickPhraseEditorOpen = false
  state.draft = { kind: 'continue', parentId: parent.id, anchorId, text, sending: false }
  render()
  window.setTimeout(focusDraftInput, 0)
}

function openBranch(parent, atSeq = undefined, anchorId = undefined) {
  if (parent.dshSessionId === null) return setError('该节点没有关联的 DSH 会话')
  state.activeId = parent.id
  state.quickPhraseEditorOpen = false
  state.draft = { kind: 'branch', parentId: parent.id, atSeq, anchorId, text: '', sending: false }
  render()
  window.setTimeout(() => document.querySelector('[data-draft] textarea')?.focus(), 0)
}

async function sendMessage(thread, text) {
  if (thread.dshSessionId === null) throw new Error('该节点没有关联的 DSH 会话')
  if (state.pendingReplies.has(thread.dshSessionId)) throw new Error('该会话正在回复，请稍后再发送')
  state.pendingReplies.set(thread.dshSessionId, { text, at: Date.now() })
  invalidateCanvasGraph()
  state.error = ''
  render()
  try {
    await dshRpc('synapse:send-message', { sessionId: thread.dshSessionId, text })
    void loadThreadHistory(thread)
  } catch (error) {
    state.pendingReplies.delete(thread.dshSessionId)
    invalidateCanvasGraph()
    render()
    throw error
  }
}

async function submitDraft() {
  const draft = state.draft
  const text = draft?.text.trim()
  if (draft === null || !text) return
  const branchPosition = draft.kind === 'branch' && state.workspace !== null ? draftPlacement(conversationCards(state.workspace.threads))?.position : undefined
  draft.sending = true
  state.error = ''
  render()
  try {
    if (draft.kind === 'new') {
      const session = await dshRpc('synapse:create-session', { workspaceId: state.selectedDshWorkspaceId, cwd: state.currentDsh?.cwd })
      await dshRpc('synapse:send-message', { sessionId: session.id, text })
      state.draft = null
      render()
      window.setTimeout(() => {
        void refreshProjection().catch(() => {})
      }, 150)
      return
    }
    const parent = state.workspace?.threads.find(thread => thread.id === draft.parentId)
    if (parent === undefined) throw new Error('来源会话不存在')
    if (draft.kind === 'continue') {
      state.draft = null
      await sendMessage(parent, text)
      return
    }
    const session = await dshRpc('synapse:fork-session', { sessionId: parent.dshSessionId, atSeq: draft.atSeq })
    if (draft.anchorId !== undefined) rememberBranchAnchor(session.id, draft.anchorId)
    const result = await api(`/synapse/api/threads/${parent.id}/branch`, { method: 'POST', body: JSON.stringify({ title: text.slice(0, 42), dshSessionId: session.id, dshSessionTitle: session.title, position: branchPosition }) })
    if (state.workspace !== null && !state.workspace.threads.some(thread => thread.id === result.thread.id || thread.dshSessionId === result.thread.dshSessionId)) state.workspace.threads.push(result.thread)
    state.activeId = result.thread.id
    state.draft = null
    state.pendingReplies.set(result.thread.dshSessionId, { text, at: Date.now() })
    invalidateCanvasGraph()
    render()
    await dshRpc('synapse:send-message', { sessionId: result.thread.dshSessionId, text })
    void loadThreadHistory(result.thread)
    await refreshProjection()
  } catch (error) {
    if (draft.kind === 'branch') {
      state.pendingReplies.delete(state.workspace?.threads.find(thread => thread.id === state.activeId)?.dshSessionId)
      invalidateCanvasGraph()
      if (state.draft !== null) state.draft = { ...draft, sending: false }
    } else {
      state.draft = { ...draft, sending: false }
    }
    setError(error)
  }
}

function threadsById() { return new Map((state.workspace?.threads ?? []).map(thread => [thread.id, thread])) }

/**
 * A session archived in DSH must not keep drawing cards here: the canvas and
 * the sidebar both read this filtered list (issue #21 / #19). Threads without a
 * DSH session (canvas-only notes) are never hidden by DSH's state.
 */
function visibleThreads(threads) {
  if (state.archivedSessionIds.size === 0) return threads
  return threads.filter(thread => thread.dshSessionId === null || !state.archivedSessionIds.has(thread.dshSessionId))
}
function persistedMessagesFor(thread) { return state.historyBySession.get(thread.dshSessionId) ?? thread.messages ?? [] }

function pendingUserIndex(messages, pending) {
  // The stored copy may be a preview, so match by full length and by the
  // preview prefix instead of by exact text equality.
  return messages.findLastIndex(message => message.kind === 'user'
    && new Date(message.at).getTime() >= pending.at - 2_000
    && (message.text === pending.text
      || (typeof message.text === 'string' && pending.text.startsWith(message.text.replace(/…$/, '')))))
}

function settlePendingReply(thread, messages) {
  const pending = state.pendingReplies.get(thread.dshSessionId)
  if (pending === undefined) return false
  const userIndex = pendingUserIndex(messages, pending)
  if (userIndex === -1 || !messages.slice(userIndex + 1).some(message => message.kind === 'error' || message.kind === 'assistant' && message.text?.trim())) return false
  state.pendingReplies.delete(thread.dshSessionId)
  return true
}

function messagesFor(thread, hydrate = true) {
  // Old rows without provenance are repaired against the original log.
  const stored = persistedMessagesFor(thread).filter(message => !(message.kind === 'user' && typeof message.sourceKind === 'string' && message.sourceKind !== 'user'))
  // Swap in hydrated bodies where present: the stored text is only a preview.
  const messages = hydrate ? stored.map(message => hydratedMessage(thread, message)) : stored
  const pending = state.pendingReplies.get(thread.dshSessionId)
  if (pending === undefined) return messages
  if (settlePendingReply(thread, messages)) {
    state.liveReplies.delete(thread.dshSessionId)
    return messages
  }
  const liveReply = state.liveReplies.get(thread.dshSessionId)
  const liveAssistant = liveReply?.running ? { kind: 'assistant', text: liveReply.text, pending: true, at: new Date().toISOString() } : { kind: 'assistant', text: '', pending: true, at: new Date().toISOString() }
  const userIndex = pendingUserIndex(messages, pending)
  if (userIndex !== -1) return [...messages, liveAssistant]
  return [...messages, { kind: 'user', text: pending.text, pending: true, at: new Date(pending.at).toISOString() }, liveAssistant]
}

function latestMessage(thread, kind) { return hydratedMessage(thread, [...messagesFor(thread, false)].reverse().find(message => message.kind === kind && (kind !== 'assistant' || message.text?.trim()))) }
function questionFor(thread) { return latestMessage(thread, 'user')?.text ?? thread.dshSessionTitle ?? '等待用户提问' }
function answerFor(thread) { return latestMessage(thread, 'assistant') ?? null }

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
}

const tableCells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())

const isTableDelimiter = line => {
  const cells = tableCells(line)
  return cells.length > 0 && cells.every(cell => /^:?-+:?$/.test(cell))
}

function markdownBlock(text) {
  const lines = text.split('\n')
  const output = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    if (line.trim() === '') { index++; continue }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading !== null) {
      const level = heading[1].length
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
      index++
      continue
    }
    const unordered = /^[-*+]\s+(.+)$/.exec(line)
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line)
    if (unordered !== null || ordered !== null) {
      const matcher = unordered === null ? /^\d+[.)]\s+(.+)$/ : /^[-*+]\s+(.+)$/
      const items = []
      while (index < lines.length) {
        const item = matcher.exec(lines[index])
        if (item === null) break
        items.push(`<li>${inlineMarkdown(item[1])}</li>`)
        index++
      }
      output.push(`<${unordered === null ? 'ol' : 'ul'}>${items.join('')}</${unordered === null ? 'ol' : 'ul'}>`)
      continue
    }
    // GFM table: a leading-pipe header row followed by a |-delimiter row,
    // then any number of leading-pipe body rows.
    if (/^\s*\|/.test(line) && index + 1 < lines.length && isTableDelimiter(lines[index + 1])) {
      const header = line
      const body = []
      index += 2
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        body.push(lines[index])
        index++
      }
      output.push(`<table><thead><tr>${tableCells(header).map(cell => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${body.map(row => `<tr>${tableCells(row).map(cell => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    const paragraph = []
    while (index < lines.length && lines[index].trim() !== '' && !/^(#{1,3})\s+/.test(lines[index]) && !/^[-*+]\s+/.test(lines[index]) && !/^\d+[.)]\s+/.test(lines[index])) paragraph.push(lines[index++])
    // A marker-only line such as PowerShell's "+ " diagnostic is neither a
    // list item nor paragraph content under the rules above. Consume it so
    // the parser always makes progress.
    if (paragraph.length === 0) paragraph.push(lines[index++])
    output.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`)
  }
  return output.join('')
}

// Markdown parsing is pure CPU and repeats for every card on every canvas
// rebuild; cache the rendered HTML by input text so stable answers are never
// re-parsed. Count the input key and HTML, not just the number of entries.
const MARKDOWN_CACHE_LIMIT = SynapseCache.LIMITS.markdownEntries
const markdownCache = new SynapseCache.ByteLru(SynapseCache.LIMITS.markdownBytes, MARKDOWN_CACHE_LIMIT)
function renderMarkdown(text, cache = true) {
  const key = String(text)
  const cached = cache ? markdownCache.get(key) : undefined
  if (cached !== undefined) return cached
  const parts = key.split(/```/)
  const rendered = parts.map((part, index) => index % 2 === 1
    ? `<pre><code>${escapeHtml(part.replace(/^\w*\n/, ''))}</code></pre>`
    : markdownBlock(part)).join('')
  const bytes = SynapseCache.textBytes(key) + SynapseCache.textBytes(rendered) + 128
  if (cache && bytes <= SynapseCache.LIMITS.markdownEntryBytes) markdownCache.set(key, rendered, SynapseCache.textBytes(rendered))
  return rendered
}

function overlapsCard(position, other) {
  return position.x < other.x + CARD_WIDTH && position.x + CARD_WIDTH > other.x
    && position.y < other.y + CARD_HEIGHT && position.y + CARD_HEIGHT > other.y
}

function firstAvailableCardPosition(position, occupied) {
  const candidate = { x: Math.round(position.x), y: Math.max(82, Math.round(position.y)) }
  while (true) {
    const collisions = occupied.filter(other => overlapsCard(candidate, other))
    if (collisions.length === 0) return candidate
    candidate.y = Math.max(...collisions.map(other => other.y + CARD_HEIGHT + CARD_GAP_Y))
  }
}

function connectorPath(fromPosition, toPosition) {
  const fromX = fromPosition.x + CARD_WIDTH
  const fromY = fromPosition.y + CARD_HEIGHT / 2
  const toX = toPosition.x
  const toY = toPosition.y + CARD_HEIGHT / 2
  const bend = Math.min(110, Math.max(36, Math.abs(toX - fromX) * .2))
  return `M ${fromX} ${fromY} C ${fromX + bend} ${fromY}, ${toX - bend} ${toY}, ${toX} ${toY}`
}

function connectorPathFromElements(fromCard, toCard) {
  const fromX = Number.parseFloat(fromCard.style.left) + CARD_WIDTH
  const fromY = Number.parseFloat(fromCard.style.top) + CARD_HEIGHT / 2
  const toX = Number.parseFloat(toCard.style.left)
  const toY = Number.parseFloat(toCard.style.top) + CARD_HEIGHT / 2
  if (![fromX, fromY, toX, toY].every(Number.isFinite)) return null
  const bend = Math.min(110, Math.max(36, Math.abs(toX - fromX) * .2))
  return `M ${fromX} ${fromY} C ${fromX + bend} ${fromY}, ${toX - bend} ${toY}, ${toX} ${toY}`
}

function selectorValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// Connector paths are rebuilt together with the canvas DOM; cache the mapping
// from card id to its incident paths so dragging never scans the whole SVG.
let connectorPathsByCard = new Map()
function cacheCardConnectors() {
  connectorPathsByCard = new Map()
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return
  for (const path of viewport.querySelectorAll('.connectors path[data-from]')) {
    const fromId = path.getAttribute('data-from')
    const toId = path.getAttribute('data-to')
    if (fromId === null || toId === null) continue
    for (const id of [fromId, toId]) {
      const paths = connectorPathsByCard.get(id)
      if (paths === undefined) connectorPathsByCard.set(id, new Set([path]))
      else paths.add(path)
    }
  }
}

function refreshCardConnectors(cardId) {
  const paths = connectorPathsByCard.get(cardId)
  if (paths === undefined || paths.size === 0) return
  const byId = state.canvasCardsById
  if (byId === undefined) return
  for (const path of paths) {
    const fromId = path.getAttribute('data-from')
    const toId = path.getAttribute('data-to')
    if (fromId === null || toId === null) continue
    const fromCard = byId.get(fromId)
    const toCard = byId.get(toId)
    if (fromCard === undefined || toCard === undefined) continue
    // Data-driven endpoints: the counterpart card may be unmounted (outside
    // the viewport) but its position is still authoritative.
    path.setAttribute('d', connectorPath(fromCard.position, toCard.position))
  }
}

function initialCanvasCamera(cards) {
  const draft = state.draft?.kind === 'new' ? { id: 'draft:new', position: { x: 86, y: 82 } } : draftPlacement(cards)
  // Focus the active conversation's latest turn, not its first: after many
  // rounds the canvas should open where work is happening, at the newest card.
  const activeCards = state.activeId === null || state.activeId === undefined ? [] : cards.filter(card => card.dshThreadId === state.activeId)
  const active = activeCards.at(-1)
  const focus = draft ?? active ?? cards[0]
  const position = focus?.position
  if (position === undefined) return { x: 0, y: 0 }
  return { x: CAMERA_INSET_X - position.x * state.zoom, y: CAMERA_INSET_Y - position.y * state.zoom }
}

function placeConversationCards(cards) {
  const saved = new Map(cards.flatMap(card => {
    if (card.positionLocked !== true) return []
    const position = state.cardPositions.get(card.id) ?? state.cardPositions.get(card.positionKey)
    return position === undefined ? [] : [[card.id, { x: position.x, y: position.y }]]
  }))
  const occupied = new SynapseCache.RegionIndex()
  for (const card of cards) {
    const position = saved.get(card.id)
    if (position !== undefined) {
      card.position = position
      continue
    }
    const candidate = { ...(card.naturalPosition ?? card.position) }
    candidate.x = Math.round(candidate.x)
    candidate.y = Math.max(82, Math.round(candidate.y))
    while (true) {
      const collisions = occupied.query({ left: candidate.x, right: candidate.x + CARD_WIDTH, top: candidate.y, bottom: candidate.y + CARD_HEIGHT })
        .filter(other => overlapsCard(candidate, other.position))
      if (collisions.length === 0) break
      candidate.y = Math.max(...collisions.map(other => other.position.y + CARD_HEIGHT + CARD_GAP_Y))
    }
    card.position = candidate
    occupied.set(card)
  }
  return cards
}

function layoutConversationGraph(cards, threads) {
  const childrenByThread = new Map()
  for (const thread of threads) {
    if (thread.parentId === null) continue
    const children = childrenByThread.get(thread.parentId) ?? []
    children.push(thread.id)
    childrenByThread.set(thread.parentId, children)
  }
  const laneByThread = new Map()
  const visitThread = threadId => {
    const stack = [threadId]
    while (stack.length > 0) {
      const id = stack.pop()
      if (laneByThread.has(id)) continue
      laneByThread.set(id, laneByThread.size)
      const children = childrenByThread.get(id) ?? []
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index])
    }
  }
  for (const thread of threads) if (thread.parentId === null) visitThread(thread.id)
  for (const thread of threads) visitThread(thread.id)

  const byId = new Map(cards.map(card => [card.id, card]))
  const positioned = new Map()
  const positionFor = card => {
    const chain = []
    const visiting = new Set()
    let current = card
    while (current !== undefined && !positioned.has(current.id) && !visiting.has(current.id)) {
      visiting.add(current.id)
      chain.push(current)
      current = current.parentId === null ? undefined : byId.get(current.parentId)
    }
    let parentPosition = current === undefined ? undefined : positioned.get(current.id)
    while (chain.length > 0) {
      const next = chain.pop()
      const position = { x: parentPosition === undefined ? 86 : parentPosition.x + 365,
        y: 82 + (laneByThread.get(next.dshThreadId) ?? 0) * (CARD_HEIGHT + CARD_GAP_Y) }
      positioned.set(next.id, position)
      parentPosition = position
    }
    return positioned.get(card.id)
  }
  for (const card of cards) {
    card.naturalPosition = positionFor(card)
    if (!card.positionLocked) card.position = card.naturalPosition
  }
  return placeConversationCards(cards)
}

function conversationCards(threads) {
  const cards = []
  const cardsByThread = new Map()
  const threadIndex = new Map(threads.map(thread => [thread.id, thread]))
  for (const thread of threads) {
    // Retained graph cards contain previews only. Hydrate an ephemeral card
    // for rendering, so cache eviction really releases body references.
    const messages = messagesFor(thread, false)
    const turns = []
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const question = messages[messageIndex]
      if (question.kind !== 'user') continue
      const replies = []
      const errors = []
      const turnMessages = [question]
      let processCount = 0
      for (let replyIndex = messageIndex + 1; replyIndex < messages.length; replyIndex++) {
        const reply = messages[replyIndex]
        if (reply.kind === 'user') break
        turnMessages.push(reply)
        if (reply.kind === 'assistant') replies.push(reply)
        if (reply.kind === 'error') errors.push(reply)
        if (Array.isArray(reply.process)) processCount += reply.process.length
        else if (reply.kind === 'tool') processCount += 1
      }
      const answer = replies.findLast(reply => reply.text?.trim()) ?? null
      const error = errors.at(-1) ?? null
      const turnIndex = turns.length
      const id = `${thread.id}:turn:${question.sourceSeq ?? messageIndex}`
      const previous = turns.at(-1)
      const positionKey = `${thread.id}:turn-index:${turnIndex}`
      const naturalPosition = previous === undefined ? { x: 86, y: 82 } : { x: previous.naturalPosition.x + 365, y: previous.naturalPosition.y }
      const savedPosition = state.cardPositions?.get(id) ?? state.cardPositions?.get(positionKey)
      const positionLocked = savedPosition !== undefined
      const position = positionLocked ? savedPosition : naturalPosition
      turns.push({
        id,
        positionKey,
        dshThreadId: thread.id,
        sourceParentId: thread.parentId,
        parentId: null,
        sourceSeq: question.sourceSeq,
        turnIndex,
        naturalPosition,
        position,
        positionLocked,
        question: question.text,
        questionMessage: question,
        turnMessages,
        answer,
        error,
        processCount,
      })
    }
    const liveReply = state.liveReplies.get(thread.dshSessionId)
    const latestTurn = turns.at(-1)
    if (liveReply?.running && latestTurn !== undefined && (latestTurn.answer === null || latestTurn.answer.pending === true)) latestTurn.answer = { kind: 'assistant', text: liveReply.text, pending: true, at: new Date().toISOString() }
    if (turns.length === 0) {
      // A DSH session containing only execution/context has no user turn.
      if (typeof thread.dshSessionId === 'string') {
        cardsByThread.set(thread.id, turns)
        continue
      }
      const id = `${thread.id}:turn:empty`
      const positionKey = `${thread.id}:turn-index:0`
      const naturalPosition = { x: 86, y: 82 }
      const savedPosition = state.cardPositions?.get(id) ?? state.cardPositions?.get(positionKey)
      const positionLocked = savedPosition !== undefined
      turns.push({
      id,
      positionKey,
      dshThreadId: thread.id,
      sourceParentId: thread.parentId,
      parentId: null,
      sourceSeq: undefined,
      turnIndex: 0,
      naturalPosition,
      position: positionLocked ? savedPosition : naturalPosition,
      positionLocked,
      question: thread.dshSessionTitle ?? thread.title,
      answer: null,
      error: null,
      processCount: 0,
      })
    }
    turns.at(-1).canContinue = true
    cardsByThread.set(thread.id, turns)
    cards.push(...turns)
  }
  for (const card of cards) {
    const siblings = cardsByThread.get(card.dshThreadId)
    if (card.turnIndex > 0) card.parentId = siblings[card.turnIndex - 1].id
    else {
      const parentCards = cardsByThread.get(card.sourceParentId)
      const sourceThread = threadIndex.get(card.dshThreadId)
      const firstChildQuestion = siblings?.[0]
      const seedLength = sourceThread?.sourceSeedLength ?? firstChildQuestion?.sourceSeq
      // A fork inherits every parent event before DSH's durable seed boundary.
      // The latest parent question below that boundary is the exact Turn where
      // this child was born. Canvas coordinates never participate in lineage.
      const inheritedTurn = Number.isSafeInteger(seedLength)
        ? parentCards?.filter(candidate => Number.isInteger(candidate.sourceSeq) && candidate.sourceSeq < seedLength).at(-1)
        : undefined
      card.parentId = state.branchAnchors.get(card.dshThreadId) ?? inheritedTurn?.id ?? null
    }
  }
  return layoutConversationGraph(cards, threads)
}

function conversationGraphView(cards, collapsedCardIds = state.collapsedCardIds) {
  const cardIds = new Set(cards.map(card => card.id))
  const childrenByParent = new Map()
  for (const card of cards) {
    if (card.parentId === null || !cardIds.has(card.parentId)) continue
    const children = childrenByParent.get(card.parentId) ?? []
    children.push(card.id)
    childrenByParent.set(card.parentId, children)
  }

  const hiddenIds = new Set()
  for (const rootId of collapsedCardIds) {
    if (!cardIds.has(rootId)) continue
    const visited = new Set([rootId])
    const pending = [rootId]
    while (pending.length > 0) {
      for (const childId of childrenByParent.get(pending.pop()) ?? []) {
        if (visited.has(childId)) continue
        visited.add(childId)
        hiddenIds.add(childId)
        pending.push(childId)
      }
    }
  }

  // Persisted collapse roots must remain visible even if malformed metadata
  // contains a cycle where two collapsed nodes otherwise hide each other.
  for (const rootId of collapsedCardIds) hiddenIds.delete(rootId)

  // Post-order accumulation: each card's descendant count is 1 + the sum of
  // its children's subtree sizes, so the whole graph is O(n) instead of a BFS
  // from every card (O(n²) on deep chains). Malformed parent cycles are
  // detected through the DFS path: every member of a cycle reaches every other
  // member plus the union of their off-cycle subtrees, so when the cycle entry
  // pops last, all members are settled to (cycleSize - 1) + off-cycle total,
  // which matches the per-card BFS' unique-descendant count.
  const descendantCounts = new Map()
  const inStack = new Set()
  for (const card of cards) {
    if (descendantCounts.has(card.id)) continue
    const stack = [{ id: card.id, children: childrenByParent.get(card.id) ?? [], index: 0 }]
    const path = [card.id]
    let cycleEntry = null
    let cycleMembers = null
    let cycleOffCycleTotal = 0
    inStack.add(card.id)
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top.index < top.children.length) {
        const childId = top.children[top.index++]
        if (descendantCounts.has(childId)) continue
        if (inStack.has(childId)) {
          // Back edge: the nodes from childId up to top.id form a cycle.
          cycleEntry = childId
          cycleMembers = new Set(path.slice(path.indexOf(childId)))
          cycleOffCycleTotal = 0
          continue
        }
        inStack.add(childId)
        path.push(childId)
        stack.push({ id: childId, children: childrenByParent.get(childId) ?? [], index: 0 })
      } else {
        stack.pop()
        path.pop()
        inStack.delete(top.id)
        let count = 0
        for (const childId of top.children) {
          if (cycleMembers !== null && cycleMembers.has(childId)) continue // ring edge; base count added below
          count += 1 + (descendantCounts.get(childId) ?? 0)
        }
        if (cycleMembers !== null && cycleMembers.has(top.id)) cycleOffCycleTotal += count
        if (cycleMembers !== null && top.id === cycleEntry) {
          // All cycle members have popped (the entry pops last in post-order);
          // settle them so ancestors popping next read the final counts.
          const base = cycleMembers.size - 1
          for (const id of cycleMembers) descendantCounts.set(id, base + cycleOffCycleTotal)
          cycleEntry = null
          cycleMembers = null
        } else {
          descendantCounts.set(top.id, count)
        }
      }
    }
  }

  return {
    cards: cards.filter(card => !hiddenIds.has(card.id)),
    childCounts: new Map(cards.map(card => [card.id, childrenByParent.get(card.id)?.length ?? 0])),
    descendantCounts,
  }
}

function revealConversationThread(cards, threadId) {
  const byId = new Map(cards.map(card => [card.id, card]))
  let changed = false
  for (const target of cards.filter(card => card.dshThreadId === threadId)) {
    const visited = new Set([target.id])
    let parentId = target.parentId
    while (parentId !== null && !visited.has(parentId)) {
      visited.add(parentId)
      if (state.collapsedCardIds.delete(parentId)) changed = true
      parentId = byId.get(parentId)?.parentId ?? null
    }
  }
  if (changed) persistCollapsedCards()
}

function canvasConnectors(cards) {
  const index = new Map(cards.map(card => [card.id, card]))
  const links = cards.map(card => {
    const parent = card.parentId === null ? null : index.get(card.parentId)
    if (parent === undefined || parent === null) return ''
    const active = card.dshThreadId === state.activeId && parent.dshThreadId === state.activeId ? ' active-connector' : ''
    return `<path class="${active.trim()}" data-from="${escapeHtml(parent.id)}" data-to="${escapeHtml(card.id)}" d="${connectorPath(parent.position, card.position)}"></path>`
  })
  const placement = draftPlacement(cards)
  if (placement !== null) {
    links.push(`<path class="draft-connector" data-from="${escapeHtml(placement.parent.id)}" data-to="draft" d="${connectorPath(placement.parent.position, placement.position)}"></path>`)
  }
  return links.join('')
}

function conversationCard(card, graph, overview = false) {
  if (!overview) card = hydratedCard(card)
  const selected = card.id === state.selectedCardId ? 'selected' : ''
  const source = card.parentId === null ? 'DSH 会话' : card.turnIndex === 0 ? 'DSH 分支' : '追问'
  const continueButton = card.canContinue === true
    ? `<button class="graph-continue-button" data-action="open-continue" data-thread="${card.dshThreadId}" data-card="${escapeHtml(card.id)}" aria-label="添加追问" title="添加追问"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9"/></svg></button>`
    : ''
  const childCount = graph.childCounts.get(card.id) ?? 0
  const collapsed = state.collapsedCardIds.has(card.id)
  const foldLabel = collapsed ? '展开后续对话' : '折叠后续对话'
  const foldButton = childCount === 0 || card.canContinue === true ? '' : `<button class="graph-fold-button${collapsed ? ' collapsed' : ''}" data-action="toggle-card-children" data-card="${escapeHtml(card.id)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${foldLabel}" title="${foldLabel}"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3.5 8h9"/>${collapsed ? '<path d="M8 3.5v9"/>' : ''}</svg></button>`
  const branchButton = childCount === 0 || card.canContinue === true || !Number.isInteger(card.answer?.sourceSeq) ? '' : `<button class="graph-branch-button" data-action="open-branch" data-thread="${card.dshThreadId}" data-card="${escapeHtml(card.id)}" data-seq="${card.answer.sourceSeq}" aria-label="在新对话中分支" title="在新对话中分支"><svg aria-hidden="true" viewBox="0 0 16 16"><path fill-rule="evenodd" clip-rule="evenodd" d="M13.0762 1.37207C14.0846 1.37228 14.9021 2.19077 14.9023 3.19922C14.9022 4.20772 14.0847 5.02518 13.0762 5.02539C12.2967 5.02539 11.6325 4.53691 11.3701 3.84961H4.35547C4.79397 4.26458 5.15861 4.7644 5.41699 5.33496L7.10645 9.06738C7.88526 10.7875 9.55104 11.9228 11.4189 12.0371C11.7085 11.4109 12.3411 10.9756 13.0762 10.9756C14.0843 10.9759 14.9023 11.7936 14.9023 12.8018C14.9023 13.81 14.0843 14.6277 13.0762 14.6279C12.2534 14.6279 11.5574 14.0832 11.3291 13.335C8.9868 13.1879 6.89981 11.7612 5.92285 9.60352L4.23242 5.87109C3.67503 4.64033 2.44878 3.84961 1.09766 3.84961V2.54883C1.10665 2.54883 1.11601 2.54975 1.125 2.5498L11.3701 2.54883C11.6326 1.86151 12.2969 1.37207 13.0762 1.37207ZM13.0762 12.2764C12.7858 12.2764 12.5508 12.5114 12.5508 12.8018C12.5508 13.0921 12.7858 13.3281 13.0762 13.3281C13.3664 13.3279 13.6025 13.092 13.6025 12.8018C13.6025 12.5115 13.3664 12.2766 13.0762 12.2764ZM13.0762 2.67285C12.7855 2.67285 12.55 2.90861 12.5498 3.19922C12.5499 3.48987 12.7855 3.72559 13.0762 3.72559C13.3667 3.72538 13.6024 3.48975 13.6025 3.19922C13.6023 2.90874 13.3666 2.67306 13.0762 2.67285Z" fill="currentColor"/></svg></button>`
  const answerText = String(card.answer?.text ?? '')
  const faceAnswer = overview
    ? `<p class="card-overview-summary">${escapeHtml(answerText.slice(0, 180) || (card.error === null ? '等待助手回复' : '本轮未完成'))}</p>`
    : card.answer === null ? (card.error === null ? '<p class="thread-answer-empty">等待助手回复</p>' : '')
      : `${renderMarkdown(answerText.slice(0, MAP_FACE_TEXT), !card.answer.pending)}${answerText.length > MAP_FACE_TEXT ? '<p class="card-face-notice">点击卡片查看完整回答</p>' : ''}${card.answer.pending ? '<p class="thread-answer-pending">正在回复</p>' : ''}`
  const question = String(card.question ?? '').slice(0, 800)
  return `<article class="thread-card ${selected}${overview ? ' card-overview' : ''}" data-card-id="${escapeHtml(card.id)}" data-position-key="${escapeHtml(card.positionKey)}" data-thread="${card.dshThreadId}" style="left:${card.position.x}px;top:${card.position.y}px;--thread-color:#3478f6">
    <button class="node-handle" data-drag-card="${card.id}" aria-label="拖动 ${escapeHtml(question)}" title="拖动卡片"></button>
    ${continueButton}${foldButton}${branchButton}
    <div class="thread-card-head"><span class="topic-dot"></span><button class="thread-title" data-action="show-thread" data-thread="${card.dshThreadId}" data-card="${escapeHtml(card.id)}" title="查看完整会话：${escapeHtml(question)}">${escapeHtml(question)}</button></div>
    <div class="thread-meta"><span>${source}</span><span>第 ${card.turnIndex + 1} 轮</span>${card.error === null ? '' : '<span class="card-error-status">失败</span>'}${card.processCount > 0 ? `<span class="card-process-count">工具 ${card.processCount}</span>` : ''}</div>
    <div class="thread-answer">${faceAnswer}${card.error === null ? '' : `<p class="thread-answer-error">本轮失败：${escapeHtml(String(card.error.text ?? '').slice(0, 300))}</p>`}</div>
    <footer><button data-action="show-thread" data-thread="${card.dshThreadId}" data-card="${escapeHtml(card.id)}" title="查看完整会话" aria-label="查看完整会话"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2 8.5 8 2.5l6 6V13.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5Z"/><path d="M6.2 14v-3.6a1.8 1.8 0 0 1 3.6 0V14" /></svg>详情</button><button data-action="open-dsh" data-thread="${card.dshThreadId}" data-seq="${Number.isInteger(card.sourceSeq) ? card.sourceSeq : ''}" title="在 DSH 中打开" aria-label="在 DSH 中打开"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5H4.5A1.5 1.5 0 0 0 3 5v6.5A1.5 1.5 0 0 0 4.5 13H11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M9.5 3.5h3v3M12.4 3.6 7.5 8.5"/></svg>DSH</button><button data-action="archive-thread" data-thread="${card.dshThreadId}" title="归档此会话" aria-label="归档此会话"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5h11M5.5 7v5.5a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V7"/><path d="M4 5 5 2.8a.7.7 0 0 1 .6-.4h4.8a.7.7 0 0 1 .6.4L12 5M6 9.5h4"/></svg>归档</button></footer>
  </article>`
}

function draftActions(draft) {
  const disabled = draft.sending ? 'disabled' : ''
  return `<div class="draft-actions"><button type="button" data-action="cancel-draft" ${disabled} aria-label="取消" title="取消"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg></button><button class="primary" type="submit" ${disabled} aria-label="发送" title="发送"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7"/></svg></button></div>`
}

function quickPhraseEditor(draft) {
  const disabled = draft.sending ? 'disabled' : ''
  const phrases = state.quickPhrases.map((phrase, index) => `<div class="draft-quick-phrase-editor-row"><input data-quick-phrase-index="${index}" maxlength="${MAX_QUICK_PHRASE_LENGTH}" value="${escapeHtml(phrase)}" aria-label="快捷词 ${index + 1}" ${disabled}><button type="button" data-action="remove-quick-phrase" data-quick-phrase-index="${index}" aria-label="删除 ${escapeHtml(phrase)}" title="删除" ${disabled}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg></button></div>`).join('')
  return `<section class="draft-quick-editor" aria-label="编辑快捷词"><div class="draft-quick-editor-list">${phrases}</div><div class="draft-quick-phrase-add"><input maxlength="${MAX_QUICK_PHRASE_LENGTH}" placeholder="添加快捷词" aria-label="添加快捷词" ${disabled}><button class="primary" type="button" data-action="add-quick-phrase" aria-label="添加快捷词" title="添加快捷词" ${disabled}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg></button></div><button class="draft-quick-editor-close" type="button" data-action="close-quick-phrase-editor" ${disabled}>完成</button></section>`
}

function draftQuickPhrases(draft) {
  const disabled = draft.sending ? 'disabled' : ''
  if (state.quickPhraseEditorOpen) return quickPhraseEditor(draft)
  const phrases = state.quickPhrases.map(phrase => `<button class="draft-quick-phrase" type="button" data-action="insert-quick-phrase" data-quick-phrase="${escapeHtml(phrase)}" ${disabled}>${escapeHtml(phrase)}</button>`).join('')
  return `<div class="draft-quick-phrases" aria-label="常用补充词">${phrases}<button class="draft-quick-phrase-add-button" type="button" data-action="open-quick-phrase-editor" aria-label="管理快捷词" title="管理快捷词" ${disabled}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg></button></div>`
}

function insertQuickPhrase(phrase) {
  const input = document.querySelector('[data-draft] textarea')
  if (!(input instanceof HTMLTextAreaElement) || state.draft === null) return
  const start = input.selectionStart
  const end = input.selectionEnd
  const prefix = input.value.slice(0, start)
  const suffix = input.value.slice(end)
  const separator = prefix !== '' && !prefix.endsWith('\n') ? '\n' : ''
  const text = `${prefix}${separator}${phrase}${suffix}`
  if (text.length > input.maxLength) return setError('追问内容不能超过 4000 个字符')
  const caret = prefix.length + separator.length + phrase.length
  input.value = text
  state.draft.text = text
  input.focus()
  input.setSelectionRange(caret, caret)
}

function addQuickPhrase(value) {
  const phrase = value.trim().slice(0, MAX_QUICK_PHRASE_LENGTH)
  if (phrase === '') return false
  if (state.quickPhrases.includes(phrase)) return setError('这个快捷词已经存在')
  if (state.quickPhrases.length >= MAX_QUICK_PHRASES) return setError(`最多保留 ${MAX_QUICK_PHRASES} 个快捷词`)
  state.quickPhrases.push(phrase)
  persistQuickPhrases()
  return true
}

function updateQuickPhrase(index, value) {
  if (!Number.isInteger(index) || index < 0 || index >= state.quickPhrases.length) return
  const phrase = value.trim().slice(0, MAX_QUICK_PHRASE_LENGTH)
  if (phrase === '') {
    state.quickPhrases.splice(index, 1)
  } else if (state.quickPhrases.some((item, itemIndex) => itemIndex !== index && item === phrase)) {
    return setError('这个快捷词已经存在')
  } else {
    state.quickPhrases[index] = phrase
  }
  persistQuickPhrases()
  render()
}

function draftPlacement(cards) {
  const draft = state.draft
  if (draft === null || draft.kind === 'new') return null
  const parent = draft.anchorId === undefined
    ? cards.filter(card => card.dshThreadId === draft.parentId).at(-1)
    : cards.find(card => card.id === draft.anchorId)
  if (parent === undefined) return null
  return { parent, position: firstAvailableCardPosition({ x: parent.position.x + 365, y: parent.position.y }, cards.map(card => card.position)) }
}

function draftCard(cards) {
  const draft = state.draft
  if (draft?.kind === 'new') return `<article class="thread-card draft-card first-session-card" data-card-id="draft" style="left:86px;top:82px;--thread-color:#3478f6">
    <div class="thread-card-head"><span class="topic-dot"></span><strong>新会话</strong></div>
    <form class="draft-branch-form" data-draft><textarea maxlength="4000" placeholder="输入第一条消息" ${draft.sending ? 'disabled' : ''}>${escapeHtml(draft.text)}</textarea>${draftActions(draft)}</form>
  </article>`
  const placement = draftPlacement(cards)
  if (draft === null || placement === null) return ''
  const continuing = draft.kind === 'continue'
  return `<article class="thread-card draft-card" data-card-id="draft" style="left:${placement.position.x}px;top:${placement.position.y}px;--thread-color:#3478f6">
    <div class="thread-card-head"><span class="topic-dot"></span><strong>${continuing ? '新的追问' : '新的分支'}</strong></div>
    <form class="draft-branch-form" data-draft>${draftQuickPhrases(draft)}<textarea maxlength="4000" placeholder="${continuing ? '输入追问' : '输入这个分支的新问题'}" ${draft.sending ? 'disabled' : ''}>${escapeHtml(draft.text)}</textarea>${draftActions(draft)}</form>
  </article>`
}

function selectionFollowupButton() {
  return `<button class="selection-followup" type="button" data-action="follow-selection" hidden aria-label="基于所选内容创建追问" title="基于所选内容追问"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3 3.5h10v6.25H7.2L4 12.5V9.75H3Z"/><path d="M8 4.9v3.4M6.3 6.6h3.4"/></svg><span>追问</span></button>`
}

let canvasGraphRevision = 0
let canvasGraphCache = null
let regionTimer = 0
let regionWorkTimer = 0
let regionGeneration = 0
let regionView = null
const regionElements = new Map()
const regionDirtyCards = new Set()
let inspectorBodyTimer = 0

function invalidateCanvasGraph() { canvasGraphRevision++ }
function cancelRegionWork() {
  window.clearTimeout(regionTimer)
  window.clearTimeout(regionWorkTimer)
  window.clearTimeout(inspectorBodyTimer)
  regionTimer = regionWorkTimer = inspectorBodyTimer = 0
  regionGeneration++
  regionDirtyCards.clear()
}

function ensureCanvasGraph(threads) {
  if (canvasGraphCache?.workspace === state.workspace && canvasGraphCache.revision === canvasGraphRevision) return
  const allCards = conversationCards(threads)
  const graph = conversationGraphView(allCards)
  const index = new SynapseCache.RegionIndex()
  const children = new Map()
  const byMessage = new Map()
  const latestByThread = new Map()
  for (const card of allCards) latestByThread.set(card.dshThreadId, card)
  for (const card of graph.cards) {
    index.set(card)
    if (card.parentId !== null) {
      if (!children.has(card.parentId)) children.set(card.parentId, [])
      children.get(card.parentId).push(card.id)
    }
    for (const message of [card.questionMessage, card.answer, card.error]) {
      if (Number.isInteger(message?.sourceSeq)) byMessage.set(`${card.dshThreadId}:${message.sourceSeq}`, card.id)
    }
  }
  canvasGraphCache = { workspace: state.workspace, revision: canvasGraphRevision, graph, index, children, byMessage,
    allById: new Map(allCards.map(card => [card.id, card])), latestByThread,
    threadById: new Map(threads.map(thread => [thread.id, thread])) }
  state.canvasCards = graph.cards
  state.canvasCardsById = new Map(graph.cards.map(card => [card.id, card]))
  state.canvasGraph = graph
}

function canvasWorldBounds(margin = 0) {
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return null
  const width = viewport.clientWidth
  const height = viewport.clientHeight
  if (width === 0 || height === 0) return null
  return { left: -state.canvasCamera.x / state.zoom - margin,
    right: (width - state.canvasCamera.x) / state.zoom + margin,
    top: -state.canvasCamera.y / state.zoom - margin,
    bottom: (height - state.canvasCamera.y) / state.zoom + margin }
}

function cardIntersects(card, bounds) {
  return card.position.x + CARD_WIDTH >= bounds.left && card.position.x <= bounds.right
    && card.position.y + CARD_HEIGHT >= bounds.top && card.position.y <= bounds.bottom
}

// Throttle region planning independently of the camera's animation frame.
// Each pending plan reads the latest camera, so rapid panning drops old work.
function syncCanvasViewport({ immediate = false } = {}) {
  if (state.mode !== 'canvas' || !state.mapVisible || document.hidden || !canvasGraphCache) return
  if (immediate) {
    window.clearTimeout(regionTimer)
    regionTimer = 0
    planCanvasRegion()
  } else if (regionTimer === 0) {
    regionTimer = window.setTimeout(() => { regionTimer = 0; planCanvasRegion() }, REGION_TICK_MS)
  }
}

function planCanvasRegion() {
  if (state.mode !== 'canvas' || !state.mapVisible || document.hidden || state.dragging) return
  const bounds = canvasWorldBounds()
  const layer = document.querySelector('.cards-layer')
  if (!bounds || !(layer instanceof HTMLElement) || !canvasGraphCache) return
  const planKey = [canvasGraphCache.revision, state.zoom < OVERVIEW_ZOOM, state.selectedCardId, state.activeId,
    state.inspectorCardId, state.canvasGesture, state.draft?.kind, state.draft?.anchorId,
    ...['left', 'right', 'top', 'bottom'].map(side => Math.floor(bounds[side] / 128))].join('|')
  if (regionView?.planKey === planKey && regionDirtyCards.size === 0) {
    hydrateBodies()
    updateRegionStatus()
    return
  }
  window.clearTimeout(regionWorkTimer)
  regionWorkTimer = 0
  const generation = ++regionGeneration
  const expanded = { left: bounds.left - REGION_MARGIN, right: bounds.right + REGION_MARGIN,
    top: bounds.top - REGION_MARGIN, bottom: bounds.bottom + REGION_MARGIN }
  const nearby = canvasGraphCache.index.query(expanded)
  const cx = (bounds.left + bounds.right) / 2
  const cy = (bounds.top + bounds.bottom) / 2
  const distance = card => (card.position.x + CARD_WIDTH / 2 - cx) ** 2 + (card.position.y + CARD_HEIGHT / 2 - cy) ** 2
  nearby.sort((a, b) => Number(cardIntersects(b, bounds)) - Number(cardIntersects(a, bounds)) || distance(a) - distance(b))
  const overview = state.zoom < OVERVIEW_ZOOM
  const limit = overview ? MAP_OVERVIEW_CARDS : MAP_DETAIL_CARDS
  const wanted = nearby.slice(0, limit)
  const ids = new Set(wanted.map(card => card.id))
  regionView = { planKey, overview, cards: wanted, ids, bounds, total: nearby.length, queue: [], prefetch: [] }
  for (const [id, element] of regionElements) {
    if (!element.isConnected || !ids.has(id)) {
      element.remove()
      regionElements.delete(id)
      state.mountedCardIds.delete(id)
      regionDirtyCards.delete(id)
    }
  }
  // Reuse live DOM after shell renders and discard references from old views.
  for (const element of layer.querySelectorAll('.thread-card[data-thread]')) {
    const id = element.dataset.cardId
    if (!ids.has(id)) { element.remove(); state.mountedCardIds.delete(id); continue }
    regionElements.set(id, element)
    state.mountedCardIds.add(id)
  }
  for (const card of wanted) {
    const element = regionElements.get(card.id)
    const stamp = `${canvasGraphCache.revision}:${overview}:${card.id === state.selectedCardId}`
    if (!element || element.dataset.regionStamp !== stamp || regionDirtyCards.has(card.id)) regionView.queue.push(card.id)
  }
  if (!overview && !state.canvasGesture) {
    const prefetchBounds = { left: bounds.left - REGION_PREFETCH_MARGIN, right: bounds.right + REGION_PREFETCH_MARGIN,
      top: bounds.top - REGION_PREFETCH_MARGIN, bottom: bounds.bottom + REGION_PREFETCH_MARGIN }
    regionView.prefetch = canvasGraphCache.index.query(prefetchBounds).filter(card => !ids.has(card.id))
      .sort((a, b) => distance(a) - distance(b)).slice(0, 12)
  }
  refreshRegionConnectors()
  hydrateBodies()
  updateRegionStatus()
  regionWorkTimer = window.setTimeout(() => mountRegionBatch(generation), 0)
}

function patchElementHtml(element, html) {
  const template = document.createElement('template')
  template.innerHTML = html
  const next = template.content.firstElementChild
  morphFrozenRoot = morphFrozenRootOfDocument()
  try { return morphNode(element, next) } finally { morphFrozenRoot = null }
}

function mountRegionBatch(generation) {
  if (generation !== regionGeneration || !regionView || state.mode !== 'canvas' || !state.mapVisible || document.hidden) return
  regionWorkTimer = 0
  const layer = document.querySelector('.cards-layer')
  if (!(layer instanceof HTMLElement)) return
  const started = performance.now()
  let count = 0
  while (regionView.queue.length > 0 && count < (regionView.overview ? 20 : 6)) {
    if (count > 0 && performance.now() - started >= 6) break
    const id = regionView.queue.shift()
    const card = state.canvasCardsById.get(id)
    if (!card) continue
    const html = conversationCard(card, state.canvasGraph, regionView.overview)
    let element = regionElements.get(id)
    if (element?.isConnected) {
      const scroll = element.querySelector('.thread-answer')?.scrollTop ?? 0
      element = patchElementHtml(element, html)
      const answer = element.querySelector('.thread-answer')
      if (answer) answer.scrollTop = scroll
    } else {
      const template = document.createElement('template')
      template.innerHTML = html
      element = template.content.firstElementChild
      layer.appendChild(element)
    }
    element.dataset.regionStamp = `${canvasGraphCache.revision}:${regionView.overview}:${card.id === state.selectedCardId}`
    regionElements.set(id, element)
    state.mountedCardIds.add(id)
    regionDirtyCards.delete(id)
    const handle = element.querySelector('[data-drag-card]')
    if (handle instanceof HTMLElement) bindDragHandle(handle)
    count++
  }
  updateRegionStatus()
  if (regionView.queue.length > 0) regionWorkTimer = window.setTimeout(() => mountRegionBatch(generation), 16)
}

function refreshRegionConnectors() {
  const svg = document.querySelector('.connectors')
  if (!svg || !regionView) return
  const placement = draftPlacement(state.canvasCards)
  const linksKey = [canvasGraphCache.revision, state.activeId, ...regionView.ids,
    placement?.parent.position.x, placement?.parent.position.y, placement?.position.x, placement?.position.y].join('|')
  if (svg.dataset.regionLinksKey === linksKey) return
  svg.dataset.regionLinksKey = linksKey
  const edges = new Set()
  const links = []
  const add = id => {
    if (edges.has(id) || links.length >= 640) return
    edges.add(id)
    const card = state.canvasCardsById.get(id)
    const parent = state.canvasCardsById.get(card?.parentId)
    if (!card || !parent) return
    const active = card.dshThreadId === state.activeId && parent.dshThreadId === state.activeId
    links.push(`<path data-morph-key="${escapeHtml(card.id)}" class="${active ? 'active-connector' : ''}" data-from="${escapeHtml(parent.id)}" data-to="${escapeHtml(card.id)}" d="${connectorPath(parent.position, card.position)}"></path>`)
  }
  for (const card of regionView.cards) {
    add(card.id)
    for (const child of canvasGraphCache.children.get(card.id) ?? []) {
      if (regionView.ids.has(child)) add(child)
      if (links.length >= 640) break
    }
  }
  if (placement) links.push(`<path class="draft-connector" data-from="${escapeHtml(placement.parent.id)}" data-to="draft" d="${connectorPath(placement.parent.position, placement.position)}"></path>`)
  // SVG parsing needs the SVG namespace, which a bare HTML template lacks.
  const template = document.createElement('template')
  template.innerHTML = `<svg>${links.join('')}</svg>`
  morphChildren(svg, template.content.firstElementChild)
  cacheCardConnectors()
}

function updateRegionStatus() {
  const status = document.querySelector('.region-status')
  if (!status || !regionView) return
  let pending = 0
  let unavailable = 0
  for (const entry of bodyLoader.wanted.values()) {
    if (entry.priority === 2 || bodyCache.get(entry.threadId, entry.seq, entry.revision) !== undefined) continue
    if (bodyLoader.unavailable(entry.threadId, entry.seq, entry.revision)) unavailable++
    else pending++
  }
  const mounting = regionView.queue.length
  const limited = regionView.total > regionView.cards.length
  const loading = mounting > 0 || pending > 0
  status.hidden = !loading && !unavailable && !limited && !regionView.overview
  status.classList.toggle('is-loading', loading)
  status.querySelector('span').textContent = loading ? `正在加载此区域 · ${mounting ? `${mounting} 张卡片` : `${pending} 条正文`}`
    : unavailable ? '部分正文暂未加载，当前显示预览'
      : limited ? `当前区域显示 ${regionView.cards.length} 张卡片，请放大查看`
        : '概览模式 · 点击卡片查看完整回答'
  status.querySelector('button').hidden = unavailable === 0
}

function syncCanvasDraft() {
  const layer = document.querySelector('.cards-layer')
  if (!layer) return
  const previous = layer.querySelector('.draft-card')
  const html = draftCard(state.canvasCards ?? [])
  if (!html) { previous?.remove(); return }
  if (previous) patchElementHtml(previous, html)
  else {
    const template = document.createElement('template')
    template.innerHTML = html
    layer.appendChild(template.content)
  }
}

function renderCanvas() {
  const threads = visibleThreads(state.workspace?.threads ?? [])
  if (threads.length === 0 && state.draft?.kind !== 'new') {
    clearViewCaches()
    state.inspectorCardId = null
    state.inspectorOpening = false
    return `<section class="empty-canvas"><strong>当前工作目录还没有 DSH 对话。</strong><p>点击新会话，在画布中输入第一条消息。</p><div><button class="primary" type="button" data-action="create-session">新建会话</button></div></section>`
  }
  ensureCanvasGraph(threads)
  const cards = state.canvasCards
  if (state.inspectorCardId !== null && !canvasGraphCache.allById.has(state.inspectorCardId)) {
    state.inspectorCardId = null
    state.inspectorOpening = false
  }
  if (!state.canvasViewInitialized) {
    state.canvasCamera = initialCanvasCamera(cards)
    state.canvasViewInitialized = true
    // The viewport is not laid out yet while renderCanvas builds its HTML;
    // center the focused card once the DOM is mounted (render tail).
    state.canvasNeedsCenter = true
  }
  const inspector = state.inspectorCardId === null ? '' : renderCardInspector(canvasGraphCache.allById.get(state.inspectorCardId))
  return `<section class="canvas-view" data-morph-key="canvas"><div class="canvas-viewport"><div class="canvas-content" style="transform:translate(${state.canvasCamera.x}px, ${state.canvasCamera.y}px) scale(${state.zoom})"><svg class="connectors" data-morph-key="links:${escapeHtml(state.workspace?.id ?? '')}" data-region-layer></svg><div class="cards-layer" data-morph-key="cards:${escapeHtml(state.workspace?.id ?? '')}" data-region-layer></div></div></div><div class="region-status" role="status" hidden><i aria-hidden="true"></i><span></span><button type="button" data-action="retry-bodies" hidden>重试</button></div>${inspector}</section>`
}

function isProcessMessage(message) {
  if (message.kind === 'tool' || message.kind === 'tool-result') return true
  return message.kind === 'assistant' && /(?:^|\n)\s*(?:bash|pwsh|powershell|web_search|web_fetch|browser|read_file|write_file)\s*\n\s*\{/.test(message.text)
}

function processSummary(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 140) || '工具调用记录'
}

function bodyNotice(thread, message) {
  if (bodyLoader.unavailable(thread.id, message.sourceSeq, bodyRevision(message))) return '<p class="body-notice">当前显示预览。<button type="button" data-action="retry-bodies">重新加载正文</button></p>'
  if (message.previewOnly && !message.hydrated) return '<p class="body-notice">正在加载正文，当前显示预览。</p>'
  if ((message.hydrated && message.truncated) || message.processTruncated || message.process?.length > 12) return '<p class="body-notice">内容较长，已显示部分正文或工具记录。请在 DSH 中查看完整内容。</p>'
  return ''
}

function threadMessage(thread, message) {
  const isUser = message.kind === 'user'
  const label = isUser ? '你' : message.kind === 'assistant' ? 'DSH' : message.kind === 'error' ? '错误' : '记录'
  const branch = message.kind === 'assistant' && Number.isInteger(message.sourceSeq)
    ? `<button class="message-branch" data-action="open-branch" data-thread="${thread.id}" data-seq="${message.sourceSeq}" title="从此回答创建分支"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M4.5 3v6a2.5 2.5 0 0 0 2.5 2.5H12"/><circle cx="4.5" cy="3" r="1.5"/><circle cx="11.5" cy="12" r="1.5"/></svg>分支</button>`
    : ''
  const messageId = `${thread.id}:${message.sourceSeq ?? `${message.kind}:${message.at}`}`
  const collapsible = isProcessMessage(message)
  const expanded = state.expandedMessageIds.has(messageId)
  const fold = collapsible ? `<button class="message-fold" data-action="toggle-message" data-message="${escapeHtml(messageId)}" aria-label="${expanded ? '收起过程记录' : '展开过程记录'}" title="${expanded ? '收起' : '展开'}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg></button>` : ''
  const process = Array.isArray(message.process) && message.process.length > 0 ? message.process : null
  const body = message.pending && message.text === '' ? '<p class="message-streaming"><span class="streaming-dot"></span>正在回复</p>'
    : `${collapsible && !expanded ? `<p class="message-summary">${escapeHtml(processSummary(message.text))}</p>` : renderMarkdown(message.text, !message.pending)}${message.pending ? '<p class="message-streaming"><span class="streaming-dot"></span>正在回复</p>' : ''}${process === null ? '' : processRecords(process, messageId)}${bodyNotice(thread, message)}`
  const avatar = isUser ? '' : '<span class="message-avatar" aria-hidden="true"></span>'
  return `<article class="message message-${message.kind}${message.pending ? ' message-pending' : ''}${collapsible ? ' message-collapsible' : ''}${expanded ? ' expanded' : ''}" data-message-seq="${Number.isInteger(message.sourceSeq) ? message.sourceSeq : ''}"><header>${avatar}<span class="message-role">${label}</span><time>${formatTime(message.at)}</time>${branch}${fold}</header><div class="message-body">${body}</div></article>`
}

/**
 * Stored process entries carry a `status` (`pending` / `done` / `failed`);
 * records folded in from a v3-era message still carry `error` / `result`. Read
 * both shapes, otherwise a finished tool renders as a failure only because the
 * newer shape has no `error` key at all (`undefined !== null`).
 */
function processState(entry) {
  if (entry.status === 'failed') return 'failed'
  if (entry.status === 'pending') return 'pending'
  if (entry.status === 'done') return 'done'
  if (typeof entry.error === 'string') return entry.error === '' ? (entry.result === null || entry.result === undefined ? 'pending' : 'done') : 'failed'
  if (entry.error !== null && entry.error !== undefined) return 'failed'
  return entry.result === null || entry.result === undefined ? 'pending' : 'done'
}

function processRecords(process, messageId) {
  const key = `${messageId}:process`
  const expanded = state.expandedMessageIds.has(key)
  const entries = expanded ? process.slice(0, 12).map((entry, index) => {
    const entryKey = `${key}:${index}`
    const entryExpanded = state.expandedMessageIds.has(entryKey)
    const state_ = processState(entry)
    const status = state_ === 'failed' ? '失败' : state_ === 'pending' ? '等待结果' : '完成'
    const statusClass = state_ === 'failed' ? ' process-status-error' : state_ === 'pending' ? ' process-status-pending' : ' process-status-done'
    const argumentsHtml = entryExpanded && typeof entry.arguments === 'string' && entry.arguments !== '' ? `<pre class="process-args">${escapeHtml(entry.arguments.slice(0, 8192))}</pre>` : ''
    const outcomeHtml = !entryExpanded ? '' : state_ === 'failed' && typeof entry.error === 'string' && entry.error !== ''
      ? `<pre class="process-error">${escapeHtml(entry.error.slice(0, 8192))}</pre>`
      : typeof entry.result === 'string' && entry.result !== '' ? `<pre class="process-result">${escapeHtml(entry.result.slice(0, 8192))}</pre>` : ''
    const truncated = entry.truncated || ['arguments', 'result', 'error'].some(field => typeof entry[field] === 'string' && entry[field].length > 8192)
    return `<div class="process-entry${entryExpanded ? ' expanded' : ''}"><button class="process-entry-fold" data-action="toggle-message" data-message="${escapeHtml(entryKey)}"><span class="process-entry-name">${escapeHtml(entry.name)}</span><span class="process-status${statusClass}">${status}</span></button>${entryExpanded ? `<div class="process-entry-body">${argumentsHtml}${outcomeHtml}${truncated ? '<p class="body-notice">工具内容已截断，请在 DSH 中查看完整记录。</p>' : ''}</div>` : ''}</div>`
  }).join('') : ''
  return `<section class="process-records${expanded ? ' expanded' : ''}"><button class="process-records-fold" data-action="toggle-message" data-message="${escapeHtml(key)}"><span>${expanded ? '收起过程记录' : '过程记录'}</span><span class="process-count">${process.length}</span></button>${expanded ? entries : ''}</section>`
}

function messagesForCard(card) {
  const thread = canvasGraphCache?.threadById.get(card.dshThreadId) ?? state.workspace?.threads.find(item => item.id === card.dshThreadId)
  if (thread === undefined) return { thread: null, messages: [] }
  if (card.turnMessages) return { thread, messages: card.turnMessages.map(message => hydratedMessage(thread, message)) }
  const messages = messagesFor(thread, false)
  let turnIndex = -1
  let start = -1
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].kind !== 'user') continue
    turnIndex += 1
    if (turnIndex === card.turnIndex) {
      start = index
      break
    }
  }
  if (start === -1) return { thread, messages: [] }
  const end = messages.findIndex((message, index) => index > start && message.kind === 'user')
  return { thread, messages: messages.slice(start, end === -1 ? undefined : end).map(message => hydratedMessage(thread, message)) }
}

function inspectorProcessEntries(messages) {
  const entries = []
  for (const message of messages) {
    if (entries.length >= 12) break
    if (Array.isArray(message.process)) {
      entries.push(...message.process.slice(0, 12 - entries.length).map(entry => ({ ...entry })))
      continue
    }
    if (message.kind === 'tool') {
      entries.push({ name: processSummary(message.text), arguments: message.text, status: 'pending' })
      continue
    }
    if (message.kind === 'tool-result') {
      const previous = entries.at(-1)
      if (previous !== undefined && processState(previous) === 'pending') {
        previous.status = 'done'
        previous.result = message.text
      } else entries.push({ name: '工具结果', arguments: null, status: 'done', result: message.text })
    }
  }
  return entries
}

function renderCardInspector(card) {
  if (card === undefined) return ''
  card = hydratedCard(card)
  const { thread, messages } = messagesForCard(card)
  if (thread === null) return ''
  const process = inspectorProcessEntries(messages).slice(0, 12)
  const answer = card.answer === null
    ? card.error === null ? '<p class="card-inspector-pending">等待助手回复</p>' : ''
    : `<article class="card-inspector-answer">${renderMarkdown(card.answer.text, !card.answer.pending)}${card.answer.pending ? '<p class="card-inspector-pending">正在回复</p>' : ''}</article>`
  const error = card.error === null ? '' : `<section class="card-inspector-error" role="alert"><strong>本轮未完成</strong><p>${escapeHtml(card.error.text)}</p></section>`
  const processRecordsHtml = process.length === 0 ? '' : processRecords(process, `${thread.id}:${card.id}:inspector`)
  const continueAction = card.canContinue === true ? `<button type="button" data-action="open-continue" data-thread="${thread.id}" data-card="${escapeHtml(card.id)}"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2.5 3.5h11v7h-6l-3.5 2.5v-2.5h-1.5Z"/><path d="M8 5.5v3M6.5 7h3"/></svg>继续追问</button>` : ''
  const branch = Number.isInteger(card.answer?.sourceSeq)
    ? `<button type="button" data-action="open-branch" data-thread="${thread.id}" data-card="${escapeHtml(card.id)}" data-seq="${card.answer.sourceSeq}"><svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="4" cy="3.5" r="1.5"/><circle cx="12" cy="3.5" r="1.5"/><circle cx="12" cy="12.5" r="1.5"/><path d="M5.5 3.5h2A2.5 2.5 0 0 1 10 6v5"/></svg>创建分支</button>`
    : ''
  const openDshAction = `<button class="primary" type="button" data-action="open-dsh" data-thread="${thread.id}" data-seq="${Number.isInteger(card.answer?.sourceSeq) ? card.answer.sourceSeq : ''}"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M7 3.5H4.5A1.5 1.5 0 0 0 3 5v6.5A1.5 1.5 0 0 0 4.5 13H11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M9.5 3.5h3v3M12.4 3.6 7.5 8.5"/></svg>在 DSH 中打开</button>`
  const notices = messages.map(message => bodyNotice(thread, message)).filter(Boolean)
  return `<aside class="card-inspector${state.inspectorOpening ? ' is-opening' : ''}" aria-label="卡片详情" data-inspector-card="${escapeHtml(card.id)}"><header class="card-inspector-head"><div><div class="card-inspector-meta"><span>第 ${card.turnIndex + 1} 轮</span>${card.error === null ? '' : '<span class="card-inspector-error-status">失败</span>'}${process.length > 0 ? `<span>工具 ${process.length}</span>` : ''}</div><h2 title="${escapeHtml(card.question)}">${escapeHtml(card.question)}</h2></div><button class="card-inspector-close" type="button" data-action="close-card-inspector" aria-label="关闭卡片详情" title="关闭"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg></button></header><div class="card-inspector-scroll">${error}${answer}${processRecordsHtml}${notices[0] ?? ''}</div><footer class="card-inspector-actions">${continueAction}${branch}${openDshAction}</footer></aside>`
}

function detailPage(thread) {
  const all = messagesFor(thread, false)
  const lastStart = Math.max(0, Math.floor((all.length - 1) / DETAIL_PAGE_MESSAGES) * DETAIL_PAGE_MESSAGES)
  const target = state.detailTargetCardId
  if (target?.startsWith(`${thread.id}:turn:`)) {
    const seq = Number(target.slice(target.lastIndexOf(':') + 1))
    const index = all.findIndex(message => message.sourceSeq === seq)
    if (index !== -1) state.detailPageByThread.set(thread.id, Math.floor(index / DETAIL_PAGE_MESSAGES) * DETAIL_PAGE_MESSAGES)
  }
  const saved = state.detailPageByThread.get(thread.id)
  const start = saved === null || saved === undefined ? lastStart : Math.min(saved, lastStart)
  return { messages: all.slice(start, start + DETAIL_PAGE_MESSAGES).map(message => hydratedMessage(thread, message)), start, total: all.length, lastStart }
}

function changeDetailPage(thread, direction) {
  const page = detailPage(thread)
  const start = Math.max(0, Math.min(page.lastStart, page.start + direction * DETAIL_PAGE_MESSAGES))
  state.detailPageByThread.set(thread.id, start === page.lastStart ? null : start)
  state.detailTargetCardId = null
  state.detailScrollByThread.set(thread.id, 0)
  state.detailThreadId = null
  render()
}

function renderThread() {
  const thread = currentThread()
  if (thread === null) return renderCanvas()
  const page = detailPage(thread)
  const messages = page.messages
  const waiting = state.pendingReplies.has(thread.dshSessionId)
  const latestAssistantSeq = [...messages].reverse().find(message => Number.isInteger(message.sourceSeq))?.sourceSeq
  const pager = `<nav class="detail-pages" aria-label="会话历史翻页"><button data-action="detail-prev" data-thread="${thread.id}" ${page.start === 0 ? 'disabled' : ''}>上一页</button><span>${page.total === 0 ? '暂无消息' : `${page.start + 1}–${page.start + messages.length} / ${page.total} 条消息`}</span><button data-action="detail-next" data-thread="${thread.id}" ${page.start >= page.lastStart ? 'disabled' : ''}>下一页</button></nav>`
  return `<section class="detail-view">
    <header class="detail-head">
      <div class="detail-head-title">
        <div class="detail-head-meta"><span class="detail-badge">${thread.parentId === null ? '会话' : '分支'}</span>${thread.dshSessionTitle ?? thread.title ? `<span class="detail-subtitle">${escapeHtml(thread.dshSessionTitle ?? thread.title)}</span>` : ''}</div>
        <h1 title="${escapeHtml(questionFor(thread))}">${escapeHtml(questionFor(thread))}</h1>
      </div>
      <div class="detail-head-actions">
        <button type="button" data-action="open-dsh" data-thread="${thread.id}" data-seq="${Number.isInteger(latestAssistantSeq) ? latestAssistantSeq : ''}" title="在原生对话中打开此会话"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M7 3.5H4.5A1.5 1.5 0 0 0 3 5v6.5A1.5 1.5 0 0 0 4.5 13H11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M9.5 3.5h3v3M12.4 3.6 7.5 8.5"/></svg>在 DSH 中打开</button>
        <button type="button" data-action="open-branch" data-thread="${thread.id}" title="基于最新回答创建分支"><svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="4" cy="3.5" r="1.5"/><circle cx="12" cy="3.5" r="1.5"/><circle cx="12" cy="12.5" r="1.5"/><path d="M5.5 3.5h2A2.5 2.5 0 0 1 10 6v5"/></svg>创建分支</button>
        <button type="button" class="primary" data-action="show-canvas"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="m6.5 3.5-4 4.5 4 4.5M3 8h10"/></svg>返回画布</button>
      </div>
    </header>
    ${pager}
    <div class="detail-scroll">${messages.map(message => threadMessage(thread, message)).join('') || '<div class="note-empty">等待这条会话的第一条消息。</div>'}</div>
    <form class="message-composer" data-compose="${thread.id}"><textarea maxlength="4000" aria-label="继续当前会话" placeholder="继续当前会话…" ${waiting ? 'disabled' : ''}></textarea><button class="primary" type="submit" ${waiting ? 'disabled' : ''}>${waiting ? '等待回复' : '发送'}</button></form>
  </section>`
}

function render() {
  if (!state.mapVisible || document.hidden) return
  // Remember the departing thread's scroll position per thread id, so
  // switching sessions restores each conversation's own place instead of
  // smearing one session's position onto another.
  if (state.mode === 'thread' && state.detailThreadId !== null) {
    const detail = document.querySelector('.detail-scroll')
    if (detail instanceof HTMLElement) state.detailScrollByThread.set(state.detailThreadId, detail.scrollTop)
  }
  if (state.mode === 'canvas' && state.inspectorCardId !== null) {
    const inspector = document.querySelector('.card-inspector-scroll')
    if (inspector instanceof HTMLElement) state.inspectorScrollByCard.set(state.inspectorCardId, inspector.scrollTop)
  }
  state.detailThreadId = state.mode === 'thread' ? state.activeId : null
  const detailScrollTop = state.detailThreadId === null ? null : state.detailScrollByThread.get(state.detailThreadId) ?? null
  const inspectorScrollTop = state.mode === 'canvas' && state.inspectorCardId !== null ? state.inspectorScrollByCard.get(state.inspectorCardId) ?? null : null
  const cardScrollTops = new Map()
  if (state.mode === 'canvas') {
    // Key by the unique card id: every card of a session shares data-thread,
    // so keying on it would clobber sibling cards' scroll positions. Only
    // scrollable answers have a position worth preserving; reading the two
    // height properties shares the same forced layout as the scrollTop read.
    for (const answer of document.querySelectorAll('.thread-card[data-thread] .thread-answer')) {
      if (answer.scrollHeight <= answer.clientHeight) continue
      const card = answer.closest('.thread-card')
      if (card instanceof HTMLElement && typeof card.dataset.cardId === 'string') cardScrollTops.set(card.dataset.cardId, answer.scrollTop)
    }
  }
  const workspace = state.workspace
  const threads = visibleThreads(workspace?.threads ?? [])
  const view = state.mode === 'thread' ? renderThread() : renderCanvas()
  const choices = workspaceChoices()
  const selectedWorkspaceId = state.selectedDshWorkspaceId ?? workspace?.id
  const canvasControls = state.mode === 'canvas' && (threads.length > 0 || state.draft?.kind === 'new') ? `<div class="canvas-controls"><button data-action="layout" title="整理节点" aria-label="整理节点"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>整理</button><button data-action="focus-active" title="定位到当前会话" aria-label="定位到当前会话"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.5v2.6M8 11.9v2.6M1.5 8h2.6M11.9 8h2.6"/></svg>定位</button><button data-action="zoom-out" aria-label="缩小" title="缩小"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3.5 8h9"/></svg></button><span>${Math.round(state.zoom * 100)}%</span><button data-action="zoom-in" aria-label="放大" title="放大"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg></button></div>` : ''
  const detailAvailable = currentThread() !== null
  const canvasTabs = `<nav class="canvas-tabs" aria-label="会话地图视图"><button class="${state.mode === 'canvas' ? 'active' : ''}" data-action="show-canvas">地图</button><button class="${state.mode === 'thread' ? 'active' : ''}" data-action="show-thread" data-thread="${state.activeId ?? ''}" ${detailAvailable ? '' : 'disabled'}>详情</button></nav>`
  morphInto(app, `<main class="synapse-shell ${state.sidebarCollapsed ? 'sidebar-collapsed' : ''}"><aside class="sidebar"><div class="sidebar-brand-row"><div class="brand" aria-label="Synapse"><svg class="brand-mark" aria-hidden="true" viewBox="0 0 32 32" fill="none"><path d="M9 10.5 16 7l7 3.5M9 10.5v8L16 22m0-15v15m7-11.5v8L16 22"/><circle cx="9" cy="10" r="2.5"/><circle cx="23" cy="10" r="2.5"/><circle cx="16" cy="23" r="2.5"/></svg><strong>Synapse</strong></div><button class="sidebar-toggle" type="button" data-action="toggle-sidebar" aria-label="${state.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}" title="${state.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="1.75" width="12.5" height="12.5" rx="2.25"/><path d="M6 2v12"/></svg></button></div><button class="new-workspace" type="button" data-action="create-session" ${state.draft !== null ? 'disabled' : ''}><svg class="new-session-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M8 4.75v6.5M4.75 8h6.5"/></svg><span>新会话</span></button><label class="workspace-label"><span>工作区</span><span class="workspace-select"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2.5 4.75h3l1.2 1.5h6.8v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"/></svg><select data-action="select-workspace" aria-label="选择工作区" ${state.draft !== null ? 'disabled' : ''}>${choices.map(item => `<option value="${item.id}" title="${escapeHtml(item.path ?? item.title)}" ${item.id === selectedWorkspaceId ? 'selected' : ''}>${escapeHtml(item.title)}</option>`).join('')}</select></span></label><div class="sidebar-heading"><span>会话</span></div><nav class="thread-tree">${threads.map(thread => `<button class="tree-row ${thread.id === state.activeId ? 'active' : ''}" data-action="select-thread" data-thread="${thread.id}" style="--thread-color:#374151"><span class="tree-dot"></span><span>${escapeHtml(threadListTitle(thread))}</span>${thread.parentId === null ? '' : '<i>分支</i>'}</button>`).join('') || '<p class="tree-empty">暂未同步会话</p>'}</nav></aside><header class="topbar">${canvasControls}</header><section class="main-stage">${state.error ? `<div class="status-message" role="alert"><span>${escapeHtml(state.error)}</span><button data-action="dismiss-error" aria-label="关闭" title="关闭">×</button></div>` : ''}${canvasTabs}${view}${selectionFollowupButton()}</section></main>`)
  if (state.mode === 'canvas' && document.querySelector('.cards-layer')) {
    syncCanvasDraft()
    syncCanvasViewport({ immediate: true })
  } else {
    cancelRegionWork()
    regionView = null
    regionElements.clear()
    state.mountedCardIds.clear()
  }
  installDragging()
  // The initial camera from renderCanvas is inset (viewport not laid out yet);
  // center it on the focused card once the canvas DOM is mounted.
  if (state.canvasNeedsCenter) {
    state.canvasNeedsCenter = false
    window.requestAnimationFrame(() => { if (state.mode === 'canvas') focusActiveCard() })
  }
  for (const [cardId, scrollTop] of cardScrollTops) {
    const answer = app.querySelector(`.thread-card[data-card-id="${CSS.escape(cardId)}"] .thread-answer`)
    if (answer instanceof HTMLElement) answer.scrollTop = scrollTop
  }
  if (detailScrollTop !== null) window.requestAnimationFrame(() => {
    const nextDetail = document.querySelector('.detail-scroll')
    if (nextDetail instanceof HTMLElement) nextDetail.scrollTop = detailScrollTop
  })
  if (inspectorScrollTop !== null) window.requestAnimationFrame(() => {
    const inspector = document.querySelector('.card-inspector-scroll')
    if (inspector instanceof HTMLElement) inspector.scrollTop = inspectorScrollTop
  })
  if (state.inspectorOpening) window.requestAnimationFrame(() => {
    document.querySelector('.card-inspector')?.classList.remove('is-opening')
    state.inspectorOpening = false
  })
  // Jump the detail view to the card the user clicked: card ids carry the
  // source sequence (`<thread>:turn:<seq>`), which matches data-message-seq
  // anchors on the rendered messages.
  const targetCardId = state.detailTargetCardId
  state.detailTargetCardId = null
  if (targetCardId !== null) {
    const match = /:turn:(\d+)$/.exec(targetCardId)
    const seq = match === null ? null : match[1]
    if (seq !== null) window.requestAnimationFrame(() => {
      const target = app.querySelector(`[data-message-seq="${CSS.escape(seq)}"]`)
      if (target instanceof HTMLElement) target.scrollIntoView({ block: 'start' })
    })
  }
  // Card faces and the detail view only hold previews: pull the real bodies for
  // whatever is on screen right now (issue #42).
  if (state.mode !== 'canvas') hydrateBodies()
}

/**
 * Ask the Host for the bodies of the messages currently on screen. The
 * workspace payload carries previews only, so each newly mounted card and each
 * opened detail view hydrates from the DSH session log.
 */
function hydrateBodies() {
  if (!state.mapVisible || document.hidden || state.workspaceLoadBusy) {
    bodyLoader.pause(); return
  }
  const wanted = []
  const add = (threadId, message, priority = 1) => {
    if (threadId === undefined || message === null || message === undefined) return
    if (!Number.isInteger(message.sourceSeq)) return
    wanted.push({ threadId, seq: message.sourceSeq, revision: bodyRevision(message), priority })
  }
  const addCard = (card, priority = 1) => {
    if (card === undefined) return
    add(card.dshThreadId, card.questionMessage, priority)
    add(card.dshThreadId, card.answer, priority)
    add(card.dshThreadId, card.error, priority)
  }
  // An inspector wins admission when an unusually large canvas viewport
  // contains more than the bounded wanted-message set.
  if (state.mode === 'canvas' && state.inspectorCardId !== null) addCard(canvasGraphCache?.allById.get(state.inspectorCardId), 0)
  if (state.mode === 'thread' && state.activeId !== null) {
    const thread = currentThread()
    if (thread !== null) {
      for (const message of detailPage(thread).messages) add(thread.id, message)
    }
  } else if (state.mode === 'canvas' && regionView && !regionView.overview) {
    for (const card of regionView.cards) addCard(card)
    for (const card of regionView.prefetch) addCard(card, 2)
  }
  const viewKey = state.mode === 'thread'
    ? `thread:${state.activeId}:${currentThread() === null ? 0 : detailPage(currentThread()).start}`
    : `canvas:${state.inspectorCardId ?? ''}`
  bodyLoader.sync(wanted, viewKey)
}

function refreshLoadedBodies(entries = []) {
  const inspectorCard = canvasGraphCache?.allById.get(state.inspectorCardId)
  let inspectorChanged = false
  for (const entry of entries) {
    const id = canvasGraphCache?.byMessage.get(`${entry.threadId}:${entry.seq}`)
    if (id && regionElements.has(id)) regionDirtyCards.add(id)
    if (inspectorCard?.dshThreadId === entry.threadId
      && [inspectorCard.questionMessage, inspectorCard.answer, inspectorCard.error].some(message => message?.sourceSeq === entry.seq)) inspectorChanged = true
  }
  if (inspectorChanged && inspectorBodyTimer === 0) {
    inspectorBodyTimer = window.setTimeout(() => { inspectorBodyTimer = 0; refreshCardInspector() }, 100)
  }
  if (regionDirtyCards.size > 0) syncCanvasViewport()
  updateRegionStatus()
}

function refreshCardInspector() {
  if (!state.mapVisible || document.hidden || state.mode !== 'canvas' || state.inspectorCardId === null) return
  const inspector = document.querySelector('.card-inspector')
  // Loading must not undo a user's in-progress close animation.
  if (!(inspector instanceof HTMLElement) || inspector.classList.contains('is-closing')) return
  if (state.dragging || state.canvasGesture) {
    if (inspectorBodyTimer === 0) inspectorBodyTimer = window.setTimeout(() => { inspectorBodyTimer = 0; refreshCardInspector() }, 100)
    return
  }
  const card = canvasGraphCache?.allById.get(state.inspectorCardId)
  if (!card) return
  const scroll = inspector.querySelector('.card-inspector-scroll')?.scrollTop ?? 0
  const next = patchElementHtml(inspector, renderCardInspector(card))
  const body = next.querySelector('.card-inspector-scroll')
  if (body) body.scrollTop = scroll
}

function renderPreservingDetailScroll() {
  render()
}

let inspectorCloseTimer = 0
function openCardInspector(cardId) {
  if (inspectorCloseTimer !== 0) {
    window.clearTimeout(inspectorCloseTimer)
    inspectorCloseTimer = 0
  }
  state.inspectorOpening = state.inspectorCardId === null
  state.inspectorCardId = cardId
}

function closeCardInspector({ animate = true } = {}) {
  if (state.inspectorCardId === null) return
  if (inspectorCloseTimer !== 0) window.clearTimeout(inspectorCloseTimer)
  const cardId = state.inspectorCardId
  const inspector = document.querySelector('.card-inspector')
  if (!animate || !(inspector instanceof HTMLElement)) {
    state.inspectorCardId = null
    state.inspectorOpening = false
    render()
    return
  }
  inspector.classList.add('is-closing')
  inspectorCloseTimer = window.setTimeout(() => {
    inspectorCloseTimer = 0
    if (state.inspectorCardId !== cardId) return
    state.inspectorCardId = null
    state.inspectorOpening = false
    render()
  }, 180)
}

function applyCanvasTransform() {
  const content = document.querySelector('.canvas-content')
  if (content instanceof HTMLElement) content.style.transform = `translate(${state.canvasCamera.x}px, ${state.canvasCamera.y}px) scale(${state.zoom})`
}

// --- DOM morphing ---------------------------------------------------------
// The canvas re-renders on every projection tick and on every streamed chunk.
// Assigning `app.innerHTML` destroys the exact node the user is pressing, and a
// click is only dispatched when mousedown and mouseup share a target, so a
// rebuild in between silently swallows the click (W3C uievents #141). Morph the
// new markup into the live tree instead: matching nodes are patched in place and
// whatever sits under the pointer stays alive.

const MORPH_KEY_ATTRIBUTES = ['data-morph-key', 'data-card-id', 'data-inspector-card', 'data-thread', 'id']

function morphKeyOf(node) {
  if (!(node instanceof Element)) return null
  for (const attribute of MORPH_KEY_ATTRIBUTES) {
    const value = node.getAttribute(attribute)
    if (value !== null && value !== '') return `${node.tagName}|${attribute}|${value}|${node.getAttribute('data-action') ?? ''}`
  }
  return null
}

// Only the node that actually owns the caret/selection is frozen — never its
// ancestors. Freezing every ancestor of the anchor froze the entire shell (a
// caret in a card's answer made `.canvas-view` and `main` un-morphable), so the
// inspector never appeared and the sidebar never refreshed after a switch.
let morphFrozenRoot = null

function morphFrozenRootOfDocument() {
  if (typeof window.getSelection !== 'function') return null
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0) return null
  const anchor = selection.anchorNode
  if (anchor === null) return null
  const element = anchor.nodeType === 1 ? anchor : anchor.parentElement
  if (element === null) return null
  return element.closest('.thread-answer, .card-inspector-answer, .message-body, [data-draft], input, textarea, [contenteditable="true"]')
}

/** Elements whose children must survive a render: they own the caret, or a selection. */
function morphKeepsChildren(node) {
  if (!(node instanceof Element)) return false
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) return true
  if (node.isContentEditable === true) return true
  // Regional layers own their incremental DOM. Shell/inspector changes must
  // not recreate every mounted card or discard the region queue.
  if (node.hasAttribute('data-region-layer')) return true
  return node === morphFrozenRoot
}

function morphNode(from, to) {
  if (from.nodeType !== to.nodeType) return replaceMorphed(from, to)
  if (from.nodeType === Node.TEXT_NODE || from.nodeType === Node.COMMENT_NODE) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue
    return from
  }
  if (!(from instanceof Element) || !(to instanceof Element) || from.tagName !== to.tagName) {
    return replaceMorphed(from, to)
  }
  // Attributes are always patched, even on the node the user just clicked: a
  // pressed button becomes document.activeElement, and treating that as "owns
  // the caret" used to freeze its whole subtree — the clicked sidebar row never
  // received its `active` class, so no row looked selected after a switch.
  for (const attribute of [...from.attributes]) {
    if (!to.hasAttribute(attribute.name)) from.removeAttribute(attribute.name)
  }
  for (const attribute of [...to.attributes]) {
    if (from.getAttribute(attribute.name) !== attribute.value) from.setAttribute(attribute.name, attribute.value)
  }
  if (!morphKeepsChildren(from)) morphChildren(from, to)
  return from
}

/** Swap one node for a copy of another and hand back the node now in the tree. */
function replaceMorphed(from, to) {
  const next = to.cloneNode(true)
  from.replaceWith(next)
  return next
}

function morphChildren(from, to) {
  const keyed = new Map()
  for (const child of [...from.childNodes]) {
    const key = morphKeyOf(child)
    if (key !== null) {
      if (!keyed.has(key)) keyed.set(key, [])
      keyed.get(key).push(child)
    }
  }
  const matched = new Set()
  let cursor = from.firstChild
  for (const next of [...to.childNodes]) {
    const key = morphKeyOf(next)
    let match = key === null ? null : keyed.get(key)?.shift() ?? null
    if (match === null && cursor !== null && morphKeyOf(cursor) === null) match = cursor
    if (match === null) {
      const inserted = next.cloneNode(true)
      from.insertBefore(inserted, cursor)
      matched.add(inserted)
      continue
    }
    if (match !== cursor) from.insertBefore(match, cursor)
    matched.add(morphNode(match, next))
    cursor = match.nextSibling
  }
  for (const child of [...from.childNodes]) {
    if (!matched.has(child)) from.removeChild(child)
  }
}

/** Patch `container`'s children to match `html` without discarding live nodes. */
function morphInto(container, html) {
  const template = document.createElement('template')
  template.innerHTML = html
  // Computed once per pass: the one subtree that must not be rebuilt because the
  // caret/selection lives in it. Everything else (inspector, sidebar rows, cards)
  // keeps updating normally.
  morphFrozenRoot = morphFrozenRootOfDocument()
  try {
    morphChildren(container, template.content)
  } finally {
    morphFrozenRoot = null
  }
}

const boundDragHandles = new WeakSet()
function bindDragHandle(handle) {
  // Cards now survive a render, so bind each drag handle once.
  if (boundDragHandles.has(handle)) return
  boundDragHandles.add(handle)
  handle.addEventListener('pointerdown', event => {
    const cardId = event.currentTarget.dataset.dragCard
    const card = event.currentTarget.closest('.thread-card')
    if (cardId === undefined || !(card instanceof HTMLElement)) return
    event.preventDefault()
    const origin = { x: event.clientX, y: event.clientY, position: { x: Number.parseFloat(card.style.left), y: Number.parseFloat(card.style.top) } }
    const aliases = card.dataset.positionKey === undefined ? [] : [card.dataset.positionKey]
    let position = origin.position
    let stopped = false
    let frame = 0
    state.dragging = true
    // Coalesce pointermove updates to one DOM pass per animation frame so a
    // high report-rate pointer cannot queue a reflow per event.
    const apply = () => {
      frame = 0
      state.cardPositions.set(cardId, { x: Math.round(position.x), y: Math.round(position.y) })
      for (const alias of aliases) state.cardPositions.set(alias, { x: Math.round(position.x), y: Math.round(position.y) })
      // Keep the virtualized data object in sync so viewport visibility and
      // connector paths track the live drag position.
      const dataCard = state.canvasCardsById?.get(cardId)
      if (dataCard !== undefined) dataCard.position = { x: position.x, y: position.y }
      card.style.left = `${position.x}px`
      card.style.top = `${position.y}px`
      refreshCardConnectors(cardId)
    }
    const move = moveEvent => {
      position = { x: origin.position.x + (moveEvent.clientX - origin.x) / state.zoom, y: origin.position.y + (moveEvent.clientY - origin.y) / state.zoom }
      if (frame === 0) frame = window.requestAnimationFrame(apply)
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
      document.removeEventListener('pointercancel', stop)
      if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0 }
      apply()
      rememberCardPosition(cardId, position, aliases)
      const dataCard = state.canvasCardsById?.get(cardId)
      if (dataCard) {
        dataCard.positionLocked = true
        canvasGraphCache?.index.set(dataCard)
      }
      if (regionView) regionView.planKey = null
      state.dragging = false
      deferCanvasRefresh(120)
      syncCanvasViewport({ immediate: true })
      // No full render: only the dragged card's inline position and its
      // connectors changed; rebuilding the whole canvas on drop is the jank.
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
    document.addEventListener('pointercancel', stop)
  })
}

function installDragging() {
  for (const handle of document.querySelectorAll('[data-drag-card]')) bindDragHandle(handle)
}

function canvasViewport(target) {
  return target instanceof Element ? target.closest('.canvas-viewport') : null
}

function zoomCanvas(viewport, nextZoom, clientX, clientY) {
  // 20% keeps a whole map readable as an overview; 400% is the detail ceiling.
  const zoom = Math.min(4, Math.max(.2, Math.round(nextZoom * 100) / 100))
  if (zoom === state.zoom) return
  const bounds = viewport.getBoundingClientRect()
  const localX = clientX - bounds.left
  const localY = clientY - bounds.top
  const worldX = (localX - state.canvasCamera.x) / state.zoom
  const worldY = (localY - state.canvasCamera.y) / state.zoom
  state.zoom = zoom
  state.canvasCamera = { x: localX - worldX * zoom, y: localY - worldY * zoom }
  const content = viewport.querySelector('.canvas-content')
  if (content instanceof HTMLElement) {
    // Drop the composited layer before zooming: a cached will-change raster
    // would be upscaled instead of re-rasterized, which was the original
    // zoom-blur bug. will-change re-applies via .is-panning on the next pan.
    content.style.willChange = 'auto'
    applyCanvasTransform()
    syncCanvasViewport()
    window.requestAnimationFrame(() => { content.style.willChange = '' })
  } else {
    applyCanvasTransform()
    syncCanvasViewport()
  }
  const label = document.querySelector('.canvas-controls span')
  if (label !== null) label.textContent = `${Math.round(state.zoom * 100)}%`
}

function zoomCanvasAtCenter(delta) {
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return
  const bounds = viewport.getBoundingClientRect()
  zoomCanvas(viewport, state.zoom + delta, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
}

function focusActiveCard() {
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return
  const cards = state.canvasCards
  if (cards === undefined || cards.length === 0) return
  // Drafts win over the active conversation's latest turn; fall back to the
  // first card. Cards may be unmounted (outside the viewport), so the focus
  // target comes from the data model, never from DOM queries.
  const draft = state.draft === null ? undefined
    : state.draft.kind === 'new' ? { position: { x: 86, y: 82 } } : draftPlacement(cards)
  const activeCards = state.activeId === null || state.activeId === undefined ? [] : cards.filter(card => card.dshThreadId === state.activeId)
  const card = draft ?? activeCards.at(-1) ?? cards[0]
  const { x: left, y: top } = card.position
  const bounds = viewport.getBoundingClientRect()
  state.canvasCamera = {
    x: bounds.width / 2 - (left + CARD_WIDTH / 2) * state.zoom,
    y: bounds.height / 2 - (top + CARD_HEIGHT / 2) * state.zoom,
  }
  applyCanvasTransform()
  syncCanvasViewport()
}

let selectionFollowup = null
let selectionFollowupFrame = 0

function hideSelectionFollowup() {
  if (selectionFollowupFrame !== 0) {
    window.cancelAnimationFrame(selectionFollowupFrame)
    selectionFollowupFrame = 0
  }
  selectionFollowup = null
  const button = app.querySelector('.selection-followup')
  if (button instanceof HTMLButtonElement) button.hidden = true
}

function selectionFollowupTarget(range) {
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement
  if (!(start instanceof Element) || !(end instanceof Element)) return null
  const answer = start.closest('.thread-answer')
  if (answer instanceof HTMLElement && answer.contains(end)) {
    const card = answer.closest('.thread-card[data-thread]:not(.draft-card)')
    if (card instanceof HTMLElement && card.dataset.thread !== undefined) return { threadId: card.dataset.thread }
  }
  const messageBody = start.closest('.message-assistant .message-body')
  const thread = currentThread()
  if (messageBody instanceof HTMLElement && messageBody.contains(end) && thread !== null) return { threadId: thread.id }
  return null
}

function updateSelectionFollowup() {
  selectionFollowupFrame = 0
  const button = app.querySelector('.selection-followup')
  const selection = window.getSelection()
  if (!(button instanceof HTMLButtonElement) || state.draft !== null || selection === null || selection.rangeCount !== 1 || selection.isCollapsed) return hideSelectionFollowup()
  const text = selection.toString().trim()
  const range = selection.getRangeAt(0)
  const target = text === '' || text.length > 4000 ? null : selectionFollowupTarget(range)
  const rect = range.getBoundingClientRect()
  if (target === null || rect.width === 0 || rect.height === 0) return hideSelectionFollowup()
  selectionFollowup = { ...target, text }
  button.dataset.thread = target.threadId
  button.style.left = `${Math.min(window.innerWidth - 12, Math.max(76, rect.right))}px`
  button.style.top = `${Math.min(window.innerHeight - 38, Math.max(8, rect.bottom + 8))}px`
  button.hidden = false
}

function queueSelectionFollowup() {
  if (selectionFollowupFrame !== 0) return
  selectionFollowupFrame = window.requestAnimationFrame(updateSelectionFollowup)
}

app.addEventListener('pointerdown', event => {
  const viewport = canvasViewport(event.target)
  if (!(viewport instanceof HTMLElement) || event.target instanceof Element && event.target.closest('.thread-card, button, textarea, select')) return
  event.preventDefault()
  const origin = { x: event.clientX, y: event.clientY, camera: { ...state.canvasCamera } }
  let pendingCamera = null
  let frame = 0
  state.canvasGesture = true
  viewport.classList.add('is-panning')
  viewport.setPointerCapture(event.pointerId)
  const apply = () => {
    frame = 0
    if (pendingCamera === null) return
    state.canvasCamera = pendingCamera
    pendingCamera = null
    applyCanvasTransform()
    syncCanvasViewport()
  }
  const move = moveEvent => {
    pendingCamera = {
      x: origin.camera.x + moveEvent.clientX - origin.x,
      y: origin.camera.y + moveEvent.clientY - origin.y,
    }
    if (frame === 0) frame = window.requestAnimationFrame(apply)
  }
  const stop = () => {
    viewport.classList.remove('is-panning')
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', stop)
    document.removeEventListener('pointercancel', stop)
    if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0 }
    apply()
    state.canvasGesture = false
    deferCanvasRefresh(120)
    syncCanvasViewport({ immediate: true })
  }
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', stop)
  document.addEventListener('pointercancel', stop)
})

app.addEventListener('wheel', event => {
  const viewport = canvasViewport(event.target)
  if (!(viewport instanceof HTMLElement)) return
  const card = event.target instanceof Element ? event.target.closest('.thread-card') : null
  if (card instanceof HTMLElement) {
    // Over a card the wheel scrolls that card's own answer with the browser's
    // native wheel (OS-smooth, never a page jump per notch); the answer's
    // overscroll-behavior: contain stops the scroll chaining into the canvas.
    const answer = card.querySelector('.thread-answer')
    if (answer instanceof HTMLElement && answer.scrollHeight > answer.clientHeight) {
      deferCanvasRefresh()
      return
    }
    // A card with no scrollable answer swallows the wheel instead of zooming.
    event.preventDefault()
    deferCanvasRefresh()
    return
  }
  event.preventDefault()
  zoomCanvas(viewport, state.zoom + (event.deltaY < 0 ? .05 : -.05), event.clientX, event.clientY)
}, { passive: false })

// Track pointer-down so the card click handler can tell a plain click from a
// text-selection or drag gesture; acting on the latter would re-render and
// wipe the user's selection.
let pointerDownPosition = null
app.addEventListener('pointerdown', event => { pointerDownPosition = { x: event.clientX, y: event.clientY } })
app.addEventListener('pointerdown', event => {
  const button = event.target instanceof Element ? event.target.closest('.selection-followup') : null
  if (button instanceof HTMLButtonElement) event.preventDefault()
  else hideSelectionFollowup()
})
app.addEventListener('pointerup', queueSelectionFollowup)
app.addEventListener('scroll', hideSelectionFollowup, true)
document.addEventListener('selectionchange', queueSelectionFollowup)
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || state.mode !== 'canvas' || state.inspectorCardId === null) return
  event.preventDefault()
  closeCardInspector({ animate: false })
})

app.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]')
  if (!(button instanceof HTMLElement)) {
    const card = event.target instanceof Element ? event.target.closest('.thread-card[data-thread]:not(.draft-card)') : null
    if (!(card instanceof HTMLElement) || event.target instanceof Element && event.target.closest('.node-handle, textarea, select, form')) return
    // A double-click selects a word and a drag selects a range; neither is a
    // select-click, so leave the selection intact instead of re-rendering.
    if (event.detail > 1) return
    if (pointerDownPosition !== null
      && Math.hypot(event.clientX - pointerDownPosition.x, event.clientY - pointerDownPosition.y) > 4) return
    const thread = state.workspace?.threads.find(item => item.id === card.dataset.thread)
    if (thread === undefined) return
    const cardId = card.dataset.cardId
    if (cardId === undefined) return
    state.activeId = thread.id
    state.selectedCardId = cardId
    openCardInspector(cardId)
    state.error = ''
    render()
    void loadThreadHistory(thread)
    // Bidirectional current-session sync: switch DSH's current session
    // without closing the map; the client confirms via synapse:current-session.
    if (thread.dshSessionId !== null) {
      if (thread.dshSessionId !== state.currentDsh?.id) state.mapCardSessionSwitches.add(thread.dshSessionId)
      post('synapse:activate-session', { sessionId: thread.dshSessionId })
    }
    return
  }
  const thread = state.workspace?.threads.find(item => item.id === button.dataset.thread)
  try {
    if (button.dataset.action === 'follow-selection') {
      const followup = selectionFollowup
      hideSelectionFollowup()
      if (followup !== null && thread !== undefined && thread.id === followup.threadId && state.draft === null) openContinue(thread, undefined, followup.text)
      return
    }
    if (button.dataset.action === 'insert-quick-phrase' && button.dataset.quickPhrase !== undefined) insertQuickPhrase(button.dataset.quickPhrase)
    if (button.dataset.action === 'open-quick-phrase-editor') { state.quickPhraseEditorOpen = true; render() }
    if (button.dataset.action === 'close-quick-phrase-editor') { state.quickPhraseEditorOpen = false; render() }
    if (button.dataset.action === 'add-quick-phrase') {
      const editor = button.closest('.draft-quick-phrase-add')
      const input = editor?.querySelector('input')
      if (input instanceof HTMLInputElement && addQuickPhrase(input.value)) {
        render()
        window.setTimeout(() => document.querySelector('.draft-quick-phrase-add input')?.focus(), 0)
      }
    }
    if (button.dataset.action === 'remove-quick-phrase') {
      const index = Number(button.dataset.quickPhraseIndex)
      if (Number.isInteger(index) && index >= 0 && index < state.quickPhrases.length) {
        state.quickPhrases.splice(index, 1)
        persistQuickPhrases()
        render()
      }
    }
    if (button.dataset.action === 'close') post('synapse:close')
    if (button.dataset.action === 'close-card-inspector') { closeCardInspector(); return }
    if (button.dataset.action === 'retry-bodies') {
      bodyLoader.retry()
      refreshCardInspector()
      updateRegionStatus()
      return
    }
    if (button.dataset.action === 'toggle-sidebar') { state.sidebarCollapsed = !state.sidebarCollapsed; render() }
    if (button.dataset.action === 'create-session') openNewSession()
    if (button.dataset.action === 'open-current' && state.currentDsh !== null) post('synapse:open-session', { sessionId: state.currentDsh.id })
    if (button.dataset.action === 'select-thread' && thread !== undefined) {
      state.mapCardSessionSwitches.clear()
      state.activeId = thread.id
      state.selectedCardId = null
      state.inspectorCardId = null
      state.inspectorOpening = false
      state.error = ''
      if (state.workspace !== null) revealConversationThread(conversationCards(state.workspace.threads), thread.id)
      render()
      // The state switch is instant, so the map has to show it: without this the
      // camera stayed on the previous conversation's cards (often thousands of
      // pixels away), and a click that worked looked like a dead button.
      window.requestAnimationFrame(() => { if (state.mode === 'canvas') focusActiveCard() })
      void loadThreadHistory(thread)
      // Bidirectional current-session sync: switch DSH's current session
      // without closing the map; the client confirms via synapse:current-session.
      if (thread.dshSessionId !== null) post('synapse:activate-session', { sessionId: thread.dshSessionId })
    }
    if (button.dataset.action === 'detail-prev' && thread !== undefined) changeDetailPage(thread, -1)
    if (button.dataset.action === 'detail-next' && thread !== undefined) changeDetailPage(thread, 1)
    if (button.dataset.action === 'show-thread' && thread !== undefined) { state.activeId = thread.id; state.mode = 'thread'; state.detailTargetCardId = button.dataset.card ?? null; render(); void loadThreadHistory(thread) }
    if (button.dataset.action === 'show-canvas') { state.mode = 'canvas'; render() }
    if (button.dataset.action === 'toggle-card-children' && button.dataset.card !== undefined) {
      const cardId = button.dataset.card
      const collapsing = !state.collapsedCardIds.has(cardId)
      if (collapsing && state.workspace !== null) {
        const allCards = conversationCards(state.workspace.threads)
        const nextCollapsed = new Set(state.collapsedCardIds).add(cardId)
        const visibleCards = conversationGraphView(allCards, nextCollapsed).cards
        const visibleIds = new Set(visibleCards.map(card => card.id))
        const draftParentId = draftPlacement(allCards)?.parent.id
        if (draftParentId !== undefined && !visibleIds.has(draftParentId)) return setError('请先完成或取消正在编辑的追问或分支')
        // Collapsing is a view operation, so it is never refused: it used to be
        // blocked whenever the active conversation would be hidden, which made
        // "−" look dead on exactly the newest card people press it on. Keep the
        // camera useful instead, by re-focusing after the collapse below.
      }
      collapsing ? state.collapsedCardIds.add(cardId) : state.collapsedCardIds.delete(cardId)
      persistCollapsedCards()
      // Keep the viewport exactly where it is: folding is about hiding a
      // subtree, not about re-framing the canvas (moving the camera on every
      // fold is disorienting). Focus the handle without scrolling for a11y.
      render()
      window.setTimeout(() => document.querySelector(`[data-action="toggle-card-children"][data-card="${selectorValue(cardId)}"]`)?.focus({ preventScroll: true }), 0)
    }
    if (button.dataset.action === 'open-continue' && thread !== undefined) openContinue(thread, button.dataset.card)
    if (button.dataset.action === 'open-branch' && thread !== undefined) {
      const requestedSeq = Number(button.dataset.seq)
      if (button.dataset.card !== undefined && !Number.isInteger(requestedSeq)) return setError('请等待这张卡片的最终回答后再创建分支')
      const fallbackSeq = latestMessage(thread, 'assistant')?.sourceSeq
      openBranch(thread, Number.isInteger(requestedSeq) ? requestedSeq : fallbackSeq, button.dataset.card)
    }
    if (button.dataset.action === 'cancel-draft') { state.draft = null; state.quickPhraseEditorOpen = false; render() }
    if (button.dataset.action === 'toggle-message' && button.dataset.message !== undefined) { state.expandedMessageIds.has(button.dataset.message) ? state.expandedMessageIds.delete(button.dataset.message) : state.expandedMessageIds.add(button.dataset.message); renderPreservingDetailScroll() }
    if (button.dataset.action === 'open-dsh' && thread?.dshSessionId !== null) post('synapse:open-session', { sessionId: thread.dshSessionId, seq: Number.isInteger(Number(button.dataset.seq)) ? Number(button.dataset.seq) : undefined })
    if (button.dataset.action === 'archive-thread' && thread !== undefined) await archiveThread(thread)
    if (button.dataset.action === 'zoom-in') zoomCanvasAtCenter(.1)
    if (button.dataset.action === 'zoom-out') zoomCanvasAtCenter(-.1)
    if (button.dataset.action === 'focus-active') focusActiveCard()
    if (button.dataset.action === 'dismiss-error') { state.error = ''; render() }
    if (button.dataset.action === 'layout' && state.workspace !== null) {
      resetCardPositions()
      resetCanvasCamera()
      render()
    }
  } catch (error) { setError(error) }
})

app.addEventListener('change', event => {
  const quickPhrase = event.target instanceof Element ? event.target.closest('[data-quick-phrase-index]') : null
  if (quickPhrase instanceof HTMLInputElement) {
    updateQuickPhrase(Number(quickPhrase.dataset.quickPhraseIndex), quickPhrase.value)
    return
  }
  const select = event.target.closest('[data-action="select-workspace"]')
  if (!(select instanceof HTMLSelectElement)) return
  const choice = workspaceChoices().find(item => item.id === select.value)
  state.inspectorCardId = null
  state.inspectorOpening = false
  if (choice?.source === 'dsh') {
    // Map → native sync: switching workspaces moves DSH's current session to
    // the workspace's most recently updated session, keeping both sides in step.
    void openDshWorkspace(choice.id, { userInitiated: true }).then(opened => {
      if (!opened) return
      const threads = state.workspace?.threads ?? []
      const latest = threads
        .filter(thread => thread.dshSessionId !== null)
        .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0]
      const sessionId = latest?.dshSessionId ?? choice.sessionIds[0]
      if (sessionId !== undefined) post('synapse:activate-session', { sessionId })
    }).catch(setError)
  } else if (choice !== undefined) { state.selectedDshWorkspaceId = null; void openWorkspace(choice.id).catch(setError) }
})
app.addEventListener('input', event => { const input = event.target; if (input instanceof HTMLTextAreaElement && input.closest('[data-draft]') && state.draft !== null) state.draft.text = input.value })
app.addEventListener('submit', event => {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  if (form.matches('[data-draft]')) { event.preventDefault(); void submitDraft(); return }
  const thread = state.workspace?.threads.find(item => item.id === form.dataset.compose)
  const input = form.querySelector('textarea')
  if (thread === undefined || !(input instanceof HTMLTextAreaElement) || input.value.trim() === '') return
  event.preventDefault()
  const text = input.value.trim()
  input.value = ''
  void sendMessage(thread, text).catch(setError)
})

window.addEventListener('message', event => {
  if (event.origin !== window.location.origin || event.data?.source !== 'dsh-synapse') return
  const data = event.data
  if (data.type === 'synapse:map-opened') {
    state.mapVisible = true
    // Do NOT reset the camera here: toggling dialog<->map for the same
    // session must keep the user's viewport. A fresh canvas (canvasView
    // not initialized) still centers via renderCanvas; a real session switch
    // re-centers in the current-session handler below.
    state.mode = 'canvas'
    render()
    window.requestAnimationFrame(() => post('synapse:map-ready'))
  }
  if (data.type === 'synapse:map-closed') pauseMapBodies()
  if (data.type === 'synapse:map-visible') { state.mapVisible = true; render() }
  if (data.type === 'synapse:theme') {
    document.documentElement.dataset.theme = data.dark === true ? 'dark' : 'light'
  }
  if (data.type === 'synapse:workspaces') {
    const nextWorkspaces = Array.isArray(data.workspaces) ? data.workspaces.filter(workspace => typeof workspace?.id === 'string' && typeof workspace.title === 'string' && Array.isArray(workspace.sessionIds)) : []
    // DSH owns the archive set; mirror it so an archived session stops drawing
    // cards here too (issue #21 / #19).
    const nextArchived = new Set(Array.isArray(data.archivedSessionIds) ? data.archivedSessionIds.filter(id => typeof id === 'string') : [])
    // The parent re-sends this on every session-list change, i.e. on every
    // streamed chunk. Acting on an unchanged payload re-ran a whole workspace
    // load and rebuilt the canvas several times a second, which is what made
    // clicking feel unresponsive and switching workspaces feel stalled.
    const signature = JSON.stringify([nextWorkspaces, [...nextArchived].sort()])
    if (signature === state.workspacesSignature) return
    state.workspacesSignature = signature
    state.dshWorkspaces = nextWorkspaces
    state.archivedSessionIds = nextArchived
    pruneWorkspaceCaches()
    const current = currentDshWorkspace()
    if (current !== undefined && current.id !== state.selectedDshWorkspaceId) void openDshWorkspace(current.id).catch(setError)
    else if (state.selectedDshWorkspaceId !== null) void openDshWorkspace(state.selectedDshWorkspaceId).catch(setError)
    else if (canReplaceView()) render()
  }
  if (data.type === 'synapse:current-session') {
    const previousId = state.currentDsh?.id
    const previousSignature = sessionSignature(state.currentDsh)
    state.currentDsh = data.session
    const nextSignature = sessionSignature(data.session)
    const preserveCanvasCamera = previousId !== data.session?.id && state.mapCardSessionSwitches.delete(data.session?.id)
    const thread = currentDshThread()
    // A status update for the old host session can arrive while a map click is
    // opening another session. Only actual navigation reconciles selection.
    if (thread !== undefined && previousId !== data.session?.id) {
      const preserveSelectedCard = state.activeId === thread.id
      state.activeId = thread.id
      if (!preserveSelectedCard) {
        state.selectedCardId = null
        state.inspectorCardId = null
        state.inspectorOpening = false
      }
      if (state.workspace !== null) revealConversationThread(conversationCards(state.workspace.threads), thread.id)
    }
    if (previousId !== data.session?.id) {
      // A real session switch: re-center on the new session's latest turn,
      // whether it lives in the same workspace (openCurrentWorkspace returns
      // false) or a different one (it resets the camera itself).
      void openCurrentWorkspace({ preserveCanvasCamera }).then(opened => {
        if (!opened && canReplaceView()) {
          render()
          if (!preserveCanvasCamera) focusActiveCard()
        }
      }).catch(setError)
    }
    // Only the fields the canvas draws matter here: the parent re-sends this
    // message for every streamed chunk, and re-rendering on each one queued a
    // full rebuild behind every click.
    else if (previousSignature !== nextSignature && canReplaceView()) render()
  }
  if (data.type === 'synapse:live-reply' && typeof data.sessionId === 'string') {
    const thread = state.workspace?.threads.find(item => item.dshSessionId === data.sessionId)
    if (thread !== undefined) {
      if (data.running === true && state.mapVisible && !document.hidden) {
        state.liveReplies.set(data.sessionId, { running: true, text: typeof data.text === 'string' ? data.text : '' })
        // Streaming: patch the live card's answer in place instead of
        // rebuilding the whole canvas on every chunk; a full render reconciles
        // at stream end. The detail view is single-thread, so keep its cheap
        // throttled full render.
        if (state.mode === 'canvas') scheduleLiveCardUpdate(data.sessionId)
        else if (canReplaceView()) scheduleLiveRender()
      } else {
        state.liveReplies.delete(data.sessionId)
        invalidateCanvasGraph()
        if (canReplaceView() || state.pendingReplies.has(data.sessionId)) renderPreservingDetailScroll()
      }
    }
  }
  if (data.type === 'synapse:forked-session' || data.type === 'synapse:created-session' || data.type === 'synapse:message-sent') settleRpc(data.requestId, data.session ?? data)
  if (data.type === 'synapse:archived-session') settleRpc(data.requestId, data)
  if (data.type === 'synapse:bridge-error') { settleRpc(data.requestId, undefined, new Error(data.message)); if (data.requestId === undefined) setError(data.message) }
})

post('synapse:request-current')
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearViewCaches(); state.liveReplies.clear(); hideSelectionFollowup(); releaseRenderedBodies() }
  else if (state.mapVisible) { post('synapse:request-current'); render() }
})
window.addEventListener('pagehide', pauseMapBodies)
window.addEventListener('pageshow', event => {
  if (event.persisted && window.parent === window) { state.mapVisible = true; render() }
})
let polling = false
let projectionPollFailures = 0
let projectionPollAfter = 0
let projectionPollWorkspaceId = null
let projectionPollError = ''
let liveRenderTimer = 0
let liveCardFrame = 0
let liveCardSessionId = null
function scheduleLiveCardUpdate(sessionId) {
  // Coalesce streaming chunks to one DOM patch per animation frame.
  liveCardSessionId = sessionId
  if (liveCardFrame !== 0) return
  liveCardFrame = window.requestAnimationFrame(() => {
    liveCardFrame = 0
    if (liveCardSessionId === null) return
    const id = liveCardSessionId
    liveCardSessionId = null
    applyLiveReplyToCard(id)
  })
}
function applyLiveReplyToCard(sessionId) {
  if (state.mode !== 'canvas') return
  // Never patch cards mid-gesture: the reflow would compete with the drag or
  // pan frame; the next live-reply chunk re-applies after the gesture ends.
  if (state.dragging || state.canvasGesture) return
  const thread = state.workspace?.threads.find(item => item.dshSessionId === sessionId)
  if (thread === undefined) return
  const live = state.liveReplies.get(sessionId)
  if (live?.running !== true) return
  const dataCard = canvasGraphCache?.latestByThread.get(thread.id)
  if (!dataCard || dataCard.answer !== null && !dataCard.answer.pending) return
  dataCard.answer = { kind: 'assistant', text: live.text, pending: true }
  if (dataCard.id === state.inspectorCardId && inspectorBodyTimer === 0) {
    inspectorBodyTimer = window.setTimeout(() => { inspectorBodyTimer = 0; refreshCardInspector() }, 100)
  }
  // Overview cards use previews and never parse a full streamed response.
  if (regionView?.overview) return
  if (regionElements.has(dataCard.id)) {
    regionDirtyCards.add(dataCard.id)
    syncCanvasViewport()
  }
}
function scheduleLiveRender() {
  if (liveRenderTimer !== 0 || !canReplaceView()) return
  liveRenderTimer = window.setTimeout(() => {
    liveRenderTimer = 0
    if (canReplaceView()) renderPreservingDetailScroll()
  }, 120)
}
async function pollProjection() {
  if (polling || !state.mapVisible || document.hidden || state.workspaceLoadBusy || !canReplaceView()) return
  const targetWorkspaceId = () => state.selectedDshWorkspaceId ?? currentDshWorkspace()?.id ?? state.workspace?.id ?? state.dshWorkspaces[0]?.id ?? null
  const workspaceId = targetWorkspaceId()
  if (workspaceId !== projectionPollWorkspaceId) {
    projectionPollWorkspaceId = workspaceId
    projectionPollFailures = 0
    projectionPollAfter = 0
  }
  if (Date.now() < projectionPollAfter) return
  polling = true
  try {
    await refreshProjection()
    projectionPollFailures = 0
    projectionPollAfter = 0
    if (projectionPollError !== '' && state.error === projectionPollError) {
      state.error = ''
      if (canReplaceView()) render()
    }
    projectionPollError = ''
  } catch (error) {
    projectionPollFailures += 1
    projectionPollAfter = Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(projectionPollFailures, 5))
    // An old workspace request cannot put an error over a newer user choice.
    if (workspaceId === targetWorkspaceId()) {
      const message = `自动刷新失败：${error instanceof Error ? error.message : String(error)}`
      if (projectionPollError !== message) {
        const mayShowError = state.error === '' || state.error === projectionPollError
        projectionPollError = message
        if (mayShowError) {
          state.error = message
          if (canReplaceView()) render()
        }
      }
    }
  } finally { polling = false }
}
void pollProjection()
window.setInterval(() => { void pollProjection() }, 1_000)
window.addEventListener('resize', () => syncCanvasViewport({ immediate: true }))
