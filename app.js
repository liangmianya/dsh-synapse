const app = document.querySelector('#app')
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
const LEGACY_CARD_POSITIONS_KEY = 'dsh-synapse:card-positions'
const CARD_POSITIONS_KEY = 'dsh-synapse:card-positions:v3'
const COLLAPSED_CARDS_KEY = 'dsh-synapse:collapsed-cards:v1'
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
const state = {
  summaries: [], workspace: null, activeId: null, mode: 'canvas', zoom: 1, currentDsh: null, sidebarCollapsed: false,
  dshWorkspaces: [], selectedDshWorkspaceId: null,
  historyBySession: new Map(), historyRequests: new Map(), pendingReplies: new Map(), pendingRpc: new Map(), liveReplies: new Map(),
  draft: null, error: '', workspaceLoad: 0, branchAnchors: new Map(savedBranchAnchors), cardPositions: new Map(savedCardPositions), collapsedCardIds: new Set(savedCollapsedCards),
  dragging: false, canvasGesture: false, canvasRefreshAfter: 0, canvasViewInitialized: false, canvasCamera: { x: 0, y: 0 },
  expandedMessageIds: new Set(),
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const formatTime = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const currentThread = () => state.workspace?.threads.find(thread => thread.id === state.activeId) ?? state.workspace?.threads[0] ?? null
const threadListTitle = thread => thread.dshSessionTitle ?? thread.title ?? questionFor(thread)

function rememberBranchAnchor(sessionId, cardId) {
  state.branchAnchors.set(sessionId, cardId)
  try { localStorage.setItem('dsh-synapse:branch-anchors', JSON.stringify([...state.branchAnchors])) } catch { /* Private browsing may disable local storage. */ }
}

function persistCardPositions() {
  try { localStorage.setItem(CARD_POSITIONS_KEY, JSON.stringify([...state.cardPositions])) } catch { /* Private browsing may disable local storage. */ }
}

function persistCollapsedCards() {
  try { localStorage.setItem(COLLAPSED_CARDS_KEY, JSON.stringify([...state.collapsedCardIds])) } catch { /* Private browsing may disable local storage. */ }
}

function rememberCardPosition(cardId, position, aliases = []) {
  state.cardPositions.set(cardId, { x: Math.round(position.x), y: Math.round(position.y) })
  for (const alias of aliases) state.cardPositions.set(alias, { x: Math.round(position.x), y: Math.round(position.y) })
  persistCardPositions()
}

function resetCardPositions() {
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
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? '请求失败')
  return body
}

function post(type, payload = {}) {
  if (window.parent !== window) window.parent.postMessage({ source: 'dsh-synapse', type, ...payload }, window.location.origin)
}

function uuidV4() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function dshRpc(type, payload = {}) {
  if (window.parent === window) return Promise.reject(new Error('请从 DSH 页面打开 Synapse 后再操作会话'))
  const requestId = uuidV4()
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
    if (event?.type === 'user/message' && text && !text.startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')) return [{ kind: 'user', text, at: event.time, sourceSeq: event.seq }]
    if (event?.type === 'assistant/message' && text) return [{ kind: 'assistant', text, at: event.time, sourceSeq: event.seq }]
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

function workspaceChoices() {
  if (state.dshWorkspaces.length > 0) return state.dshWorkspaces.map(workspace => ({ ...workspace, source: 'dsh' }))
  return state.summaries.map(workspace => ({ id: workspace.id, title: workspace.title, path: workspace.cwd, sessionIds: [], source: 'projection' }))
}

async function threadsForDshWorkspace(workspace) {
  if (workspace.sessionIds.length === 0) return []
  const requested = new Set(workspace.sessionIds)
  const projections = await Promise.all(state.summaries.map(summary => api(`/synapse/api/workspaces/${summary.id}`)))
  return projections.flatMap(projection => projection.workspace.threads.filter(thread => requested.has(thread.dshSessionId)))
}

async function openDshWorkspace(id, { renderAfter = true } = {}) {
  const workspace = state.dshWorkspaces.find(item => item.id === id)
  if (workspace === undefined) return false
  const load = ++state.workspaceLoad
  state.selectedDshWorkspaceId = id
  const threads = await threadsForDshWorkspace(workspace)
  if (load !== state.workspaceLoad) return true
  const nextWorkspaceId = `dsh:${workspace.id}`
  if (state.workspace?.id !== nextWorkspaceId) resetCanvasCamera()
  state.workspace = { id: nextWorkspaceId, title: workspace.title, cwd: workspace.path, threads }
  const currentThread = currentDshThread(state.workspace.threads)
  state.activeId = currentThread?.id ?? (state.workspace.threads.some(thread => thread.id === state.activeId) ? state.activeId : state.workspace.threads[0]?.id ?? null)
  if (currentThread !== undefined) revealConversationThread(conversationCards(state.workspace.threads), currentThread.id)
  if (renderAfter && canReplaceView()) render()
  await Promise.all(state.workspace.threads.map(thread => loadThreadHistory(thread, false)))
  if (renderAfter && load === state.workspaceLoad && canReplaceView()) render()
  return true
}

async function openCurrentWorkspace() {
  const workspace = currentDshWorkspace()
  if (workspace === undefined || workspace.id === state.selectedDshWorkspaceId) return false
  return openDshWorkspace(workspace.id)
}

async function refreshSummaries({ renderAfter = true } = {}) {
  const before = JSON.stringify(state.summaries)
  const body = await api('/synapse/api/workspaces')
  state.summaries = body.workspaces
  const changed = before !== JSON.stringify(state.summaries)
  const current = state.workspace?.id
  if (state.selectedDshWorkspaceId === null && current !== null && !state.summaries.some(item => item.id === current)) state.workspace = null
  const selected = selectedDshWorkspace()
  if (selected !== undefined && (changed || state.workspace === null)) await openDshWorkspace(selected.id, { renderAfter })
  else if (state.workspace === null && state.summaries.length > 0) await openWorkspace(state.summaries[0].id)
  else if (renderAfter && changed && canReplaceView()) render()
  return changed
}

async function openWorkspace(id, { renderAfter = true } = {}) {
  const load = ++state.workspaceLoad
  const body = await api(`/synapse/api/workspaces/${id}`)
  if (load !== state.workspaceLoad) return
  if (state.workspace?.id !== body.workspace.id) resetCanvasCamera()
  state.workspace = body.workspace
  state.activeId = state.workspace.threads.some(thread => thread.id === state.activeId) ? state.activeId : state.workspace.threads[0]?.id ?? null
  if (renderAfter && canReplaceView()) render()
  await Promise.all(state.workspace.threads.map(thread => loadThreadHistory(thread, false)))
  if (renderAfter && load === state.workspaceLoad && canReplaceView()) render()
}

async function refreshProjection() {
  const summariesChanged = await refreshSummaries({ renderAfter: false })
  if (!summariesChanged || state.workspace === null || !canReplaceView()) return summariesChanged
  if (state.selectedDshWorkspaceId !== null) await openDshWorkspace(state.selectedDshWorkspaceId)
  else await openWorkspace(state.workspace.id)
  return true
}

function openNewSession() {
  if (state.draft !== null) return
  state.mode = 'canvas'
  state.activeId = null
  state.draft = { kind: 'new', text: '', sending: false }
  state.error = ''
  resetCanvasCamera()
  render()
  window.setTimeout(() => document.querySelector('[data-draft] textarea')?.focus(), 0)
}

async function archiveThread(thread) {
  if (!window.confirm(`归档画布中的「${thread.title}」及其分支？DSH 原会话会保留，可在 DSH 内继续查看。`)) return
  await api(`/synapse/api/threads/${thread.id}`, { method: 'DELETE' })
  state.historyBySession.delete(thread.dshSessionId)
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

function openContinue(parent, anchorId = undefined) {
  if (parent.dshSessionId === null) return setError('该节点没有关联的 DSH 会话')
  state.activeId = parent.id
  state.draft = { kind: 'continue', parentId: parent.id, anchorId, text: '', sending: false }
  render()
  window.setTimeout(() => document.querySelector('[data-draft] textarea')?.focus(), 0)
}

function openBranch(parent, atSeq = undefined, anchorId = undefined) {
  if (parent.dshSessionId === null) return setError('该节点没有关联的 DSH 会话')
  state.activeId = parent.id
  state.draft = { kind: 'branch', parentId: parent.id, atSeq, anchorId, text: '', sending: false }
  render()
  window.setTimeout(() => document.querySelector('[data-draft] textarea')?.focus(), 0)
}

async function sendMessage(thread, text) {
  if (thread.dshSessionId === null) throw new Error('该节点没有关联的 DSH 会话')
  if (state.pendingReplies.has(thread.dshSessionId)) throw new Error('该会话正在回复，请稍后再发送')
  state.pendingReplies.set(thread.dshSessionId, { text, at: Date.now() })
  state.error = ''
  render()
  try {
    await dshRpc('synapse:send-message', { sessionId: thread.dshSessionId, text })
    void loadThreadHistory(thread)
  } catch (error) {
    state.pendingReplies.delete(thread.dshSessionId)
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
    render()
    await dshRpc('synapse:send-message', { sessionId: result.thread.dshSessionId, text })
    void loadThreadHistory(result.thread)
    await refreshProjection()
  } catch (error) {
    if (draft.kind === 'branch') {
      state.pendingReplies.delete(state.workspace?.threads.find(thread => thread.id === state.activeId)?.dshSessionId)
      if (state.draft !== null) state.draft = { ...draft, sending: false }
    } else {
      state.draft = { ...draft, sending: false }
    }
    setError(error)
  }
}

function threadsById() { return new Map((state.workspace?.threads ?? []).map(thread => [thread.id, thread])) }
function persistedMessagesFor(thread) { return state.historyBySession.get(thread.dshSessionId) ?? thread.messages ?? [] }

function pendingUserIndex(messages, pending) {
  return messages.findLastIndex(message => message.kind === 'user' && message.text === pending.text && new Date(message.at).getTime() >= pending.at - 2_000)
}

function settlePendingReply(thread, messages) {
  const pending = state.pendingReplies.get(thread.dshSessionId)
  if (pending === undefined) return false
  const userIndex = pendingUserIndex(messages, pending)
  if (userIndex === -1 || !messages.slice(userIndex + 1).some(message => message.kind === 'assistant')) return false
  state.pendingReplies.delete(thread.dshSessionId)
  return true
}

function messagesFor(thread) {
  // A runtime-context snapshot is internal DSH state, never a user turn.
  // Filter here as well as during persistence so existing saved workspaces
  // immediately render one question and its answer as one card.
  const messages = persistedMessagesFor(thread).filter(message => !(message.kind === 'user' && typeof message.text === 'string' && message.text.trimStart().startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')))
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

function latestMessage(thread, kind) { return [...messagesFor(thread)].reverse().find(message => message.kind === kind) }
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
// re-parsed. Bounded: streaming partial texts churn keys, so evict oldest.
const markdownCache = new Map()
const MARKDOWN_CACHE_LIMIT = 500
function renderMarkdown(text) {
  const key = String(text)
  const cached = markdownCache.get(key)
  if (cached !== undefined) return cached
  const parts = key.split(/```/)
  const rendered = parts.map((part, index) => index % 2 === 1
    ? `<pre><code>${escapeHtml(part.replace(/^\w*\n/, ''))}</code></pre>`
    : markdownBlock(part)).join('')
  if (markdownCache.size >= MARKDOWN_CACHE_LIMIT) markdownCache.delete(markdownCache.keys().next().value)
  markdownCache.set(key, rendered)
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

function refreshCardConnectors(cardId) {
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return
  const id = selectorValue(cardId)
  for (const path of viewport.querySelectorAll(`.connectors path[data-from="${id}"], .connectors path[data-to="${id}"]`)) {
    const fromId = path.getAttribute('data-from')
    const toId = path.getAttribute('data-to')
    if (fromId === null || toId === null) continue
    const fromCard = viewport.querySelector(`[data-card-id="${selectorValue(fromId)}"]`)
    const toCard = viewport.querySelector(`[data-card-id="${selectorValue(toId)}"]`)
    if (!(fromCard instanceof HTMLElement) || !(toCard instanceof HTMLElement)) continue
    const nextPath = connectorPathFromElements(fromCard, toCard)
    if (nextPath !== null) path.setAttribute('d', nextPath)
  }
}

function initialCanvasCamera(cards) {
  const draft = state.draft?.kind === 'new' ? { id: 'draft:new', position: { x: 86, y: 82 } } : draftPlacement(cards)
  const active = state.activeId === null ? undefined : cards.find(card => card.dshThreadId === state.activeId)
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
  const occupied = []
  for (const card of cards) {
    const position = saved.get(card.id)
    if (position !== undefined) {
      card.position = position
      continue
    }
    card.position = firstAvailableCardPosition(card.naturalPosition ?? card.position, occupied)
    occupied.push(card.position)
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
    if (laneByThread.has(threadId)) return
    laneByThread.set(threadId, laneByThread.size)
    for (const childId of childrenByThread.get(threadId) ?? []) visitThread(childId)
  }
  for (const thread of threads) if (thread.parentId === null) visitThread(thread.id)
  for (const thread of threads) visitThread(thread.id)

  const byId = new Map(cards.map(card => [card.id, card]))
  const positioned = new Map()
  const positionFor = (card, visiting = new Set()) => {
    if (positioned.has(card.id)) return positioned.get(card.id)
    if (visiting.has(card.id)) return { x: 86, y: 82 + (laneByThread.get(card.dshThreadId) ?? 0) * (CARD_HEIGHT + CARD_GAP_Y) }
    visiting.add(card.id)
    const parent = card.parentId === null ? undefined : byId.get(card.parentId)
    const parentPosition = parent === undefined ? undefined : positionFor(parent, visiting)
    const position = {
      x: parentPosition === undefined ? 86 : parentPosition.x + 365,
      y: 82 + (laneByThread.get(card.dshThreadId) ?? 0) * (CARD_HEIGHT + CARD_GAP_Y),
    }
    visiting.delete(card.id)
    positioned.set(card.id, position)
    return position
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
  for (const thread of threads) {
    const messages = messagesFor(thread)
    const turns = []
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const question = messages[messageIndex]
      if (question.kind !== 'user') continue
      const replies = []
      for (let replyIndex = messageIndex + 1; replyIndex < messages.length; replyIndex++) {
        const reply = messages[replyIndex]
        if (reply.kind === 'user') break
        if (reply.kind === 'assistant') replies.push(reply)
      }
      const answer = replies.at(-1) ?? null
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
        answer,
      })
    }
    const liveReply = state.liveReplies.get(thread.dshSessionId)
    const latestTurn = turns.at(-1)
    if (liveReply?.running && latestTurn !== undefined && (latestTurn.answer === null || latestTurn.answer.pending === true)) latestTurn.answer = { kind: 'assistant', text: liveReply.text, pending: true, at: new Date().toISOString() }
    if (turns.length === 0) {
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
      const sourceThread = threads.find(thread => thread.id === card.dshThreadId)
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
    const visit = parentId => {
      for (const childId of childrenByParent.get(parentId) ?? []) {
        if (visited.has(childId)) continue
        visited.add(childId)
        hiddenIds.add(childId)
        visit(childId)
      }
    }
    visit(rootId)
  }

  // Persisted collapse roots must remain visible even if malformed metadata
  // contains a cycle where two collapsed nodes otherwise hide each other.
  for (const rootId of collapsedCardIds) hiddenIds.delete(rootId)

  const descendantCounts = new Map()
  for (const card of cards) {
    const visited = new Set([card.id])
    const pending = [...(childrenByParent.get(card.id) ?? [])]
    while (pending.length > 0) {
      const descendantId = pending.pop()
      if (visited.has(descendantId)) continue
      visited.add(descendantId)
      pending.push(...(childrenByParent.get(descendantId) ?? []))
    }
    descendantCounts.set(card.id, visited.size - 1)
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
    return `<path data-from="${escapeHtml(parent.id)}" data-to="${escapeHtml(card.id)}" d="${connectorPath(parent.position, card.position)}"></path>`
  })
  const placement = draftPlacement(cards)
  if (placement !== null) {
    links.push(`<path class="draft-connector" data-from="${escapeHtml(placement.parent.id)}" data-to="draft" d="${connectorPath(placement.parent.position, placement.position)}"></path>`)
  }
  return links.join('')
}

function conversationCard(card, graph) {
  const active = card.dshThreadId === state.activeId ? 'active' : ''
  const source = card.parentId === null ? 'DSH 会话' : card.turnIndex === 0 ? 'DSH 分支' : '追问'
  const continueButton = card.canContinue === true
    ? `<button class="graph-continue-button" data-action="open-continue" data-thread="${card.dshThreadId}" data-card="${escapeHtml(card.id)}" aria-label="添加追问" title="添加追问"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9"/></svg></button>`
    : ''
  const childCount = graph.childCounts.get(card.id) ?? 0
  const collapsed = state.collapsedCardIds.has(card.id)
  const foldLabel = collapsed ? '展开后续对话' : '折叠后续对话'
  const foldButton = childCount === 0 || card.canContinue === true ? '' : `<button class="graph-fold-button${collapsed ? ' collapsed' : ''}" data-action="toggle-card-children" data-card="${escapeHtml(card.id)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${foldLabel}" title="${foldLabel}"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3.5 8h9"/>${collapsed ? '<path d="M8 3.5v9"/>' : ''}</svg></button>`
  const branchButton = childCount === 0 || card.canContinue === true || !Number.isInteger(card.answer?.sourceSeq) ? '' : `<button class="graph-branch-button" data-action="open-branch" data-thread="${card.dshThreadId}" data-card="${escapeHtml(card.id)}" data-seq="${card.answer.sourceSeq}" aria-label="在新对话中分支" title="在新对话中分支"><svg aria-hidden="true" viewBox="0 0 16 16"><path fill-rule="evenodd" clip-rule="evenodd" d="M13.0762 1.37207C14.0846 1.37228 14.9021 2.19077 14.9023 3.19922C14.9022 4.20772 14.0847 5.02518 13.0762 5.02539C12.2967 5.02539 11.6325 4.53691 11.3701 3.84961H4.35547C4.79397 4.26458 5.15861 4.7644 5.41699 5.33496L7.10645 9.06738C7.88526 10.7875 9.55104 11.9228 11.4189 12.0371C11.7085 11.4109 12.3411 10.9756 13.0762 10.9756C14.0843 10.9759 14.9023 11.7936 14.9023 12.8018C14.9023 13.81 14.0843 14.6277 13.0762 14.6279C12.2534 14.6279 11.5574 14.0832 11.3291 13.335C8.9868 13.1879 6.89981 11.7612 5.92285 9.60352L4.23242 5.87109C3.67503 4.64033 2.44878 3.84961 1.09766 3.84961V2.54883C1.10665 2.54883 1.11601 2.54975 1.125 2.5498L11.3701 2.54883C11.6326 1.86151 12.2969 1.37207 13.0762 1.37207ZM13.0762 12.2764C12.7858 12.2764 12.5508 12.5114 12.5508 12.8018C12.5508 13.0921 12.7858 13.3281 13.0762 13.3281C13.3664 13.3279 13.6025 13.092 13.6025 12.8018C13.6025 12.5115 13.3664 12.2766 13.0762 12.2764ZM13.0762 2.67285C12.7855 2.67285 12.55 2.90861 12.5498 3.19922C12.5499 3.48987 12.7855 3.72559 13.0762 3.72559C13.3667 3.72538 13.6024 3.48975 13.6025 3.19922C13.6023 2.90874 13.3666 2.67306 13.0762 2.67285Z" fill="currentColor"/></svg></button>`
  return `<article class="thread-card ${active}" data-card-id="${escapeHtml(card.id)}" data-position-key="${escapeHtml(card.positionKey)}" data-thread="${card.dshThreadId}" style="left:${card.position.x}px;top:${card.position.y}px;--thread-color:#3478f6">
    <button class="node-handle" data-drag-card="${card.id}" aria-label="拖动 ${escapeHtml(card.question)}" title="拖动卡片"></button>
    ${continueButton}${foldButton}${branchButton}
    <div class="thread-card-head"><span class="topic-dot"></span><button class="thread-title" data-action="show-thread" data-thread="${card.dshThreadId}" title="查看完整会话：${escapeHtml(card.question)}">${escapeHtml(card.question)}</button></div>
    <div class="thread-meta"><span>${source}</span><span>第 ${card.turnIndex + 1} 轮</span></div>
    <div class="thread-answer">${card.answer === null ? '<p class="thread-answer-empty">等待助手回复</p>' : card.answer.pending && card.answer.text === '' ? '<p class="thread-answer-pending">正在回复</p>' : `${renderMarkdown(card.answer.text)}${card.answer.pending ? '<p class="thread-answer-pending">正在回复</p>' : ''}`}</div>
    <footer><button data-action="show-thread" data-thread="${card.dshThreadId}">详情</button><button data-action="open-dsh" data-thread="${card.dshThreadId}">打开 DSH</button><button data-action="archive-thread" data-thread="${card.dshThreadId}">归档</button></footer>
  </article>`
}

function draftActions(draft) {
  const disabled = draft.sending ? 'disabled' : ''
  return `<div class="draft-actions"><button type="button" data-action="cancel-draft" ${disabled} aria-label="取消" title="取消"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg></button><button class="primary" type="submit" ${disabled} aria-label="发送" title="发送"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7"/></svg></button></div>`
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
    <form class="draft-branch-form" data-draft><textarea maxlength="4000" placeholder="${continuing ? '输入追问' : '输入这个分支的新问题'}" ${draft.sending ? 'disabled' : ''}>${escapeHtml(draft.text)}</textarea>${draftActions(draft)}</form>
  </article>`
}

function renderCanvas() {
  const threads = state.workspace?.threads ?? []
  if (threads.length === 0 && state.draft?.kind !== 'new') return `<section class="empty-canvas"><strong>当前工作目录还没有 DSH 对话。</strong><p>点击新会话，在画布中输入第一条消息。</p><div><button class="primary" type="button" data-action="create-session">新建会话</button></div></section>`
  const allCards = conversationCards(threads)
  const graph = conversationGraphView(allCards)
  const cards = graph.cards
  if (!state.canvasViewInitialized) {
    state.canvasCamera = initialCanvasCamera(cards)
    state.canvasViewInitialized = true
  }
  return `<section class="canvas-view"><div class="canvas-viewport"><div class="canvas-content" style="transform:translate(${state.canvasCamera.x}px, ${state.canvasCamera.y}px) scale(${state.zoom})"><svg class="connectors">${canvasConnectors(cards)}</svg><div class="cards-layer">${cards.map(card => conversationCard(card, graph)).join('')}${draftCard(cards)}</div></div></div></section>`
}

function isProcessMessage(message) {
  if (message.kind === 'tool' || message.kind === 'tool-result') return true
  return message.kind === 'assistant' && /(?:^|\n)\s*(?:bash|pwsh|powershell|web_search|web_fetch|browser|read_file|write_file)\s*\n\s*\{/.test(message.text)
}

function processSummary(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 140) || '工具调用记录'
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
    : `${collapsible && !expanded ? `<p class="message-summary">${escapeHtml(processSummary(message.text))}</p>` : renderMarkdown(message.text)}${message.pending ? '<p class="message-streaming"><span class="streaming-dot"></span>正在回复</p>' : ''}${process === null ? '' : processRecords(process, messageId)}`
  const avatar = isUser ? '' : '<span class="message-avatar" aria-hidden="true"></span>'
  return `<article class="message message-${message.kind}${message.pending ? ' message-pending' : ''}${collapsible ? ' message-collapsible' : ''}${expanded ? ' expanded' : ''}"><header>${avatar}<span class="message-role">${label}</span><time>${formatTime(message.at)}</time>${branch}${fold}</header><div class="message-body">${body}</div></article>`
}

function processRecords(process, messageId) {
  const key = `${messageId}:process`
  const expanded = state.expandedMessageIds.has(key)
  const entries = process.map((entry, index) => {
    const entryKey = `${key}:${index}`
    const entryExpanded = state.expandedMessageIds.has(entryKey)
    const status = entry.error !== null ? '失败' : entry.result === null ? '等待结果' : '完成'
    const argumentsHtml = entry.arguments === null || entry.arguments === '' ? '' : `<pre class="process-args">${escapeHtml(entry.arguments)}</pre>`
    const outcomeHtml = entry.error !== null ? `<pre class="process-error">${escapeHtml(entry.error)}</pre>` : entry.result === null ? '' : `<pre class="process-result">${escapeHtml(entry.result)}</pre>`
    return `<div class="process-entry${entryExpanded ? ' expanded' : ''}"><button class="process-entry-fold" data-action="toggle-message" data-message="${escapeHtml(entryKey)}"><span class="process-entry-name">${escapeHtml(entry.name)}</span><span class="process-status${entry.error !== null ? ' process-status-error' : entry.result === null ? ' process-status-pending' : ' process-status-done'}">${status}</span></button>${entryExpanded ? `<div class="process-entry-body">${argumentsHtml}${outcomeHtml}</div>` : ''}</div>`
  }).join('')
  return `<section class="process-records${expanded ? ' expanded' : ''}"><button class="process-records-fold" data-action="toggle-message" data-message="${escapeHtml(key)}"><span>${expanded ? '收起过程记录' : '过程记录'}</span><span class="process-count">${process.length}</span></button>${expanded ? entries : ''}</section>`
}

function renderThread() {
  const thread = currentThread()
  if (thread === null) return renderCanvas()
  const messages = messagesFor(thread)
  const waiting = state.pendingReplies.has(thread.dshSessionId)
  return `<section class="detail-view"><header class="detail-head"><div class="detail-head-title"><div class="detail-head-meta"><span class="detail-badge">${thread.parentId === null ? '会话' : '分支'}</span>${thread.dshSessionTitle ?? thread.title ? `<span class="detail-subtitle">${escapeHtml(thread.dshSessionTitle ?? thread.title)}</span>` : ''}</div><h1>${escapeHtml(questionFor(thread))}</h1></div><div class="detail-head-actions"><button data-action="open-dsh" data-thread="${thread.id}" title="在原生对话中打开此会话">在 DSH 中打开</button><button data-action="open-branch" data-thread="${thread.id}" title="基于最新回答创建分支">创建分支</button><button class="primary" data-action="show-canvas">返回画布</button></div></header><div class="detail-scroll">${messages.map(message => threadMessage(thread, message)).join('') || '<div class="note-empty">等待这条会话的第一条消息。</div>'}</div><form class="message-composer" data-compose="${thread.id}"><textarea maxlength="4000" placeholder="继续当前会话…" ${waiting ? 'disabled' : ''}></textarea><button class="primary" type="submit" ${waiting ? 'disabled' : ''}>${waiting ? '等待回复' : '发送'}</button></form></section>`
}

function render() {
  const detail = state.mode === 'thread' ? document.querySelector('.detail-scroll') : null
  const detailScrollTop = detail instanceof HTMLElement ? detail.scrollTop : null
  const cardScrollTops = new Map()
  if (state.mode === 'canvas') {
    // Key by the unique card id: every card of a session shares data-thread,
    // so keying on it would clobber sibling cards' scroll positions.
    for (const answer of document.querySelectorAll('.thread-card[data-thread] .thread-answer')) {
      const card = answer.closest('.thread-card')
      if (card instanceof HTMLElement && typeof card.dataset.cardId === 'string') cardScrollTops.set(card.dataset.cardId, answer.scrollTop)
    }
  }
  const workspace = state.workspace
  const threads = workspace?.threads ?? []
  const view = state.mode === 'thread' ? renderThread() : renderCanvas()
  const choices = workspaceChoices()
  const selectedWorkspaceId = state.selectedDshWorkspaceId ?? workspace?.id
  const canvasControls = state.mode === 'canvas' && (threads.length > 0 || state.draft?.kind === 'new') ? `<div class="canvas-controls"><button data-action="layout">整理节点</button><button data-action="focus-active" title="定位到当前会话">定位</button><button data-action="zoom-out" aria-label="缩小">-</button><span>${Math.round(state.zoom * 100)}%</span><button data-action="zoom-in" aria-label="放大">+</button></div>` : ''
  const detailAvailable = currentThread() !== null
  const canvasTabs = `<nav class="canvas-tabs" aria-label="会话地图视图"><button class="${state.mode === 'canvas' ? 'active' : ''}" data-action="show-canvas">地图</button><button class="${state.mode === 'thread' ? 'active' : ''}" data-action="show-thread" data-thread="${state.activeId ?? ''}" ${detailAvailable ? '' : 'disabled'}>详情</button></nav>`
  app.innerHTML = `<main class="synapse-shell ${state.sidebarCollapsed ? 'sidebar-collapsed' : ''}"><aside class="sidebar"><div class="sidebar-brand-row"><div class="brand" aria-label="Synapse"><svg class="brand-mark" aria-hidden="true" viewBox="0 0 32 32" fill="none"><path d="M9 10.5 16 7l7 3.5M9 10.5v8L16 22m0-15v15m7-11.5v8L16 22"/><circle cx="9" cy="10" r="2.5"/><circle cx="23" cy="10" r="2.5"/><circle cx="16" cy="23" r="2.5"/></svg><strong>Synapse</strong></div><button class="sidebar-toggle" type="button" data-action="toggle-sidebar" aria-label="${state.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}" title="${state.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="1.75" width="12.5" height="12.5" rx="2.25"/><path d="M6 2v12"/></svg></button></div><button class="new-workspace" type="button" data-action="create-session" ${state.draft !== null ? 'disabled' : ''}><svg class="new-session-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M8 4.75v6.5M4.75 8h6.5"/></svg><span>新会话</span></button><label class="workspace-label"><span>工作区</span><span class="workspace-select"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2.5 4.75h3l1.2 1.5h6.8v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"/></svg><select data-action="select-workspace" aria-label="选择工作区" ${state.draft !== null ? 'disabled' : ''}>${choices.map(item => `<option value="${item.id}" title="${escapeHtml(item.path ?? item.title)}" ${item.id === selectedWorkspaceId ? 'selected' : ''}>${escapeHtml(item.title)}</option>`).join('')}</select></span></label><div class="sidebar-heading"><span>会话</span></div><nav class="thread-tree">${threads.map(thread => `<button class="tree-row ${thread.id === state.activeId ? 'active' : ''}" data-action="select-thread" data-thread="${thread.id}" style="--thread-color:#374151"><span class="tree-dot"></span><span>${escapeHtml(threadListTitle(thread))}</span>${thread.parentId === null ? '' : '<i>分支</i>'}</button>`).join('') || '<p class="tree-empty">暂未同步会话</p>'}</nav></aside><header class="topbar"><div class="view-switch" role="group" aria-label="视图切换"><button data-action="close" type="button" aria-pressed="false">对话</button><button class="active" type="button" aria-pressed="true">会话地图</button></div>${canvasControls}</header><section class="main-stage">${state.error ? `<div class="status-message" role="alert"><span>${escapeHtml(state.error)}</span><button data-action="dismiss-error" aria-label="关闭" title="关闭">×</button></div>` : ''}${canvasTabs}${view}</section></main>`
  installDragging()
  for (const [cardId, scrollTop] of cardScrollTops) {
    const answer = app.querySelector(`.thread-card[data-card-id="${CSS.escape(cardId)}"] .thread-answer`)
    if (answer instanceof HTMLElement) answer.scrollTop = scrollTop
  }
  if (detailScrollTop !== null) window.requestAnimationFrame(() => {
    const nextDetail = document.querySelector('.detail-scroll')
    if (nextDetail instanceof HTMLElement) nextDetail.scrollTop = detailScrollTop
  })
}

function renderPreservingDetailScroll() {
  render()
}

function applyCanvasTransform() {
  const content = document.querySelector('.canvas-content')
  if (content instanceof HTMLElement) content.style.transform = `translate(${state.canvasCamera.x}px, ${state.canvasCamera.y}px) scale(${state.zoom})`
}

function installDragging() {
  for (const handle of document.querySelectorAll('[data-drag-card]')) handle.addEventListener('pointerdown', event => {
    const cardId = event.currentTarget.dataset.dragCard
    const card = event.currentTarget.closest('.thread-card')
    if (cardId === undefined || !(card instanceof HTMLElement)) return
    event.preventDefault()
    const origin = { x: event.clientX, y: event.clientY, position: { x: Number.parseFloat(card.style.left), y: Number.parseFloat(card.style.top) } }
    const aliases = card.dataset.positionKey === undefined ? [] : [card.dataset.positionKey]
    let position = origin.position
    let stopped = false
    state.dragging = true
    const move = moveEvent => {
      position = { x: origin.position.x + (moveEvent.clientX - origin.x) / state.zoom, y: origin.position.y + (moveEvent.clientY - origin.y) / state.zoom }
      state.cardPositions.set(cardId, { x: Math.round(position.x), y: Math.round(position.y) })
      for (const alias of aliases) state.cardPositions.set(alias, { x: Math.round(position.x), y: Math.round(position.y) })
      card.style.left = `${position.x}px`
      card.style.top = `${position.y}px`
      refreshCardConnectors(cardId)
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
      document.removeEventListener('pointercancel', stop)
      rememberCardPosition(cardId, position, aliases)
      state.dragging = false
      deferCanvasRefresh(120)
      render()
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
    document.addEventListener('pointercancel', stop)
  })
}

function canvasViewport(target) {
  return target instanceof Element ? target.closest('.canvas-viewport') : null
}

function zoomCanvas(viewport, nextZoom, clientX, clientY) {
  const zoom = Math.min(4, Math.max(.6, Math.round(nextZoom * 100) / 100))
  if (zoom === state.zoom) return
  const bounds = viewport.getBoundingClientRect()
  const localX = clientX - bounds.left
  const localY = clientY - bounds.top
  const worldX = (localX - state.canvasCamera.x) / state.zoom
  const worldY = (localY - state.canvasCamera.y) / state.zoom
  state.zoom = zoom
  state.canvasCamera = { x: localX - worldX * zoom, y: localY - worldY * zoom }
  applyCanvasTransform()
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
  const card = document.querySelector('.thread-card.active') ?? document.querySelector('.thread-card[data-thread]:not(.draft-card)')
  const viewport = document.querySelector('.canvas-viewport')
  if (!(card instanceof HTMLElement) || !(viewport instanceof HTMLElement)) return
  const left = Number.parseFloat(card.style.left)
  const top = Number.parseFloat(card.style.top)
  if (!Number.isFinite(left) || !Number.isFinite(top)) return
  const bounds = viewport.getBoundingClientRect()
  state.canvasCamera = {
    x: bounds.width / 2 - (left + CARD_WIDTH / 2) * state.zoom,
    y: bounds.height / 2 - (top + CARD_HEIGHT / 2) * state.zoom,
  }
  applyCanvasTransform()
}

app.addEventListener('pointerdown', event => {
  const viewport = canvasViewport(event.target)
  if (!(viewport instanceof HTMLElement) || event.target instanceof Element && event.target.closest('.thread-card, button, textarea, select')) return
  event.preventDefault()
  const origin = { x: event.clientX, y: event.clientY, camera: { ...state.canvasCamera } }
  state.canvasGesture = true
  viewport.classList.add('is-panning')
  viewport.setPointerCapture(event.pointerId)
  const move = moveEvent => {
    state.canvasCamera = {
      x: origin.camera.x + moveEvent.clientX - origin.x,
      y: origin.camera.y + moveEvent.clientY - origin.y,
    }
    applyCanvasTransform()
  }
  const stop = () => {
    viewport.classList.remove('is-panning')
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', stop)
    document.removeEventListener('pointercancel', stop)
    state.canvasGesture = false
    deferCanvasRefresh(120)
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
    state.activeId = thread.id
    state.error = ''
    render()
    void loadThreadHistory(thread)
    // Bidirectional current-session sync: switch DSH's current session
    // without closing the map; the client confirms via synapse:current-session.
    if (thread.dshSessionId !== null) post('synapse:activate-session', { sessionId: thread.dshSessionId })
    return
  }
  const thread = state.workspace?.threads.find(item => item.id === button.dataset.thread)
  try {
    if (button.dataset.action === 'close') post('synapse:close')
    if (button.dataset.action === 'toggle-sidebar') { state.sidebarCollapsed = !state.sidebarCollapsed; render() }
    if (button.dataset.action === 'create-session') openNewSession()
    if (button.dataset.action === 'open-current' && state.currentDsh !== null) post('synapse:open-session', { sessionId: state.currentDsh.id })
    if (button.dataset.action === 'select-thread' && thread !== undefined) {
      state.activeId = thread.id
      state.error = ''
      if (state.workspace !== null) revealConversationThread(conversationCards(state.workspace.threads), thread.id)
      render()
      void loadThreadHistory(thread)
      // Bidirectional current-session sync: switch DSH's current session
      // without closing the map; the client confirms via synapse:current-session.
      if (thread.dshSessionId !== null) post('synapse:activate-session', { sessionId: thread.dshSessionId })
    }
    if (button.dataset.action === 'show-thread' && thread !== undefined) { state.activeId = thread.id; state.mode = 'thread'; render(); void loadThreadHistory(thread) }
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
        if (state.activeId !== null && !visibleCards.some(card => card.dshThreadId === state.activeId)) return setError('当前会话位于这个后续分支中，请先切换会话')
      }
      collapsing ? state.collapsedCardIds.add(cardId) : state.collapsedCardIds.delete(cardId)
      persistCollapsedCards()
      render()
      window.setTimeout(() => document.querySelector(`[data-action="toggle-card-children"][data-card="${selectorValue(cardId)}"]`)?.focus(), 0)
    }
    if (button.dataset.action === 'open-continue' && thread !== undefined) openContinue(thread, button.dataset.card)
    if (button.dataset.action === 'open-branch' && thread !== undefined) {
      const requestedSeq = Number(button.dataset.seq)
      if (button.dataset.card !== undefined && !Number.isInteger(requestedSeq)) return setError('请等待这张卡片的最终回答后再创建分支')
      const fallbackSeq = latestMessage(thread, 'assistant')?.sourceSeq
      openBranch(thread, Number.isInteger(requestedSeq) ? requestedSeq : fallbackSeq, button.dataset.card)
    }
    if (button.dataset.action === 'cancel-draft') { state.draft = null; render() }
    if (button.dataset.action === 'toggle-message' && button.dataset.message !== undefined) { state.expandedMessageIds.has(button.dataset.message) ? state.expandedMessageIds.delete(button.dataset.message) : state.expandedMessageIds.add(button.dataset.message); renderPreservingDetailScroll() }
    if (button.dataset.action === 'open-dsh' && thread?.dshSessionId !== null) post('synapse:open-session', { sessionId: thread.dshSessionId })
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
  const select = event.target.closest('[data-action="select-workspace"]')
  if (!(select instanceof HTMLSelectElement)) return
  const choice = workspaceChoices().find(item => item.id === select.value)
  if (choice?.source === 'dsh') {
    // Map → native sync: switching workspaces moves DSH's current session to
    // the workspace's most recently updated session, keeping both sides in step.
    void openDshWorkspace(choice.id).then(opened => {
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
    resetCanvasCamera()
    state.mode = 'canvas'
    render()
    window.requestAnimationFrame(() => post('synapse:map-ready'))
  }
  if (data.type === 'synapse:theme') {
    document.documentElement.dataset.theme = data.dark === true ? 'dark' : 'light'
  }
  if (data.type === 'synapse:workspaces') {
    state.dshWorkspaces = Array.isArray(data.workspaces) ? data.workspaces.filter(workspace => typeof workspace?.id === 'string' && typeof workspace.title === 'string' && Array.isArray(workspace.sessionIds)) : []
    const current = currentDshWorkspace()
    if (current !== undefined && current.id !== state.selectedDshWorkspaceId) void openDshWorkspace(current.id).catch(setError)
    else if (state.selectedDshWorkspaceId !== null) void openDshWorkspace(state.selectedDshWorkspaceId).catch(setError)
    else if (canReplaceView()) render()
  }
  if (data.type === 'synapse:current-session') {
    const previousId = state.currentDsh?.id
    state.currentDsh = data.session
    const thread = currentDshThread()
    if (thread !== undefined) {
      state.activeId = thread.id
      if (state.workspace !== null) revealConversationThread(conversationCards(state.workspace.threads), thread.id)
    }
    if (previousId !== data.session?.id) void openCurrentWorkspace().then(opened => { if (!opened && canReplaceView()) render() }).catch(setError)
    else if (canReplaceView()) render()
  }
  if (data.type === 'synapse:live-reply' && typeof data.sessionId === 'string') {
    const thread = state.workspace?.threads.find(item => item.dshSessionId === data.sessionId)
    if (thread !== undefined) {
      if (data.running === true) {
        state.liveReplies.set(data.sessionId, { running: true, text: typeof data.text === 'string' ? data.text : '' })
        // Streaming: patch the live card's answer in place instead of
        // rebuilding the whole canvas on every chunk; a full render reconciles
        // at stream end. The detail view is single-thread, so keep its cheap
        // throttled full render.
        if (state.mode === 'canvas') scheduleLiveCardUpdate(data.sessionId)
        else if (canReplaceView()) scheduleLiveRender()
      } else {
        state.liveReplies.delete(data.sessionId)
        if (canReplaceView() || state.pendingReplies.has(data.sessionId)) renderPreservingDetailScroll()
      }
    }
  }
  if (data.type === 'synapse:forked-session' || data.type === 'synapse:created-session' || data.type === 'synapse:message-sent') settleRpc(data.requestId, data.session ?? data)
  if (data.type === 'synapse:bridge-error') { settleRpc(data.requestId, undefined, new Error(data.message)); if (data.requestId === undefined) setError(data.message) }
})

post('synapse:request-current')
refreshSummaries().catch(setError)
let polling = false
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
  const thread = state.workspace?.threads.find(item => item.dshSessionId === sessionId)
  if (thread === undefined) return
  const live = state.liveReplies.get(sessionId)
  if (live?.running !== true) return
  const cards = app.querySelectorAll(`.thread-card[data-thread="${CSS.escape(thread.id)}"]`)
  const card = cards[cards.length - 1]
  if (!(card instanceof HTMLElement)) return
  const answer = card.querySelector('.thread-answer')
  if (!(answer instanceof HTMLElement)) return
  const text = live.text
  answer.innerHTML = text.trim() === ''
    ? '<p class="thread-answer-pending">正在回复</p>'
    : `${renderMarkdown(text)}<p class="thread-answer-pending">正在回复</p>`
}
function scheduleLiveRender() {
  if (liveRenderTimer !== 0 || !canReplaceView()) return
  liveRenderTimer = window.setTimeout(() => {
    liveRenderTimer = 0
    if (canReplaceView()) renderPreservingDetailScroll()
  }, 120)
}
async function pollProjection() {
  if (polling || document.hidden || !canReplaceView()) return
  polling = true
  try {
    await refreshProjection()
  } finally { polling = false }
}
window.setInterval(() => { void pollProjection() }, 1_000)
