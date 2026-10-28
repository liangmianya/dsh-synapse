import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'synapse'
export const inject = ['webServer', 'sessions']

const MAX_BODY_BYTES = 32 * 1024
const MAX_TITLE_LENGTH = 120
const MAX_NOTE_LENGTH = 4_000
// Projected message text cap: longer replies truncate with a marker pointing
// at the detail view instead of silently cutting mid-sentence.
// Projected messages keep only a short preview: the body already lives in the
// DSH session log, and a canvas full of copies is what made one workspace file
// grow to megabytes (issue #42). Bodies are streamed back on demand by
// `/synapse/api/threads/:id/full`.
const EXCERPT_CHARS = 280
// On-demand bodies are capped so a single enormous tool result cannot stall the
// browser while its card is rendered.
const MAX_BODY_CHARS = 200_000
const PROJECTION_TRUNCATED_SUFFIX = '\n——…（详情查看全文）'
const BODY_TRUNCATED_SUFFIX = '\n——…（正文过长，其余请在 DSH 中查看）'
const TOPIC_COLORS = ['#0f766e', '#2563eb', '#be123c', '#7c3aed', '#b45309']
// The harness writes `user/message` rows of its own (runtime snapshots, skill
// catalogues). A canvas card must stand for a turn a person actually typed, so
// an injected row is recognised by its structured `source.kind` instead of by
// guessing at the prose (issue #31 / #23).
const INJECTED_USER_SOURCE_KINDS = new Set(['skill-catalog'])
// Stored projections keep no raw event to re-read, so the one-time cleanup
// recognises a legacy catalogue card by the markers only that injection emits:
// the `<system-reminder>` opener plus the `<available_skills>` index it wraps.
const SKILL_CATALOG_OPENER = '<system-reminder>'
const SKILL_CATALOG_MARKER = '<available_skills>'
const LOCK_STALE_MS = 60_000
// Deferred (event-projection) writes coalesce into one save per window, so a
// burst of session events costs a single full-state write instead of one per
// event (issue #13: per-event saves pinned the main thread at ~90% CPU).
const SAVE_DEBOUNCE_MS = 800

/** JSON persistence for the Synapse workspace graph. */
export class WorkspaceStore {
  constructor(dataFile) {
    if (typeof dataFile !== 'string' || dataFile.length === 0) throw new Error('synapse: config.dataFile must be a non-empty path')
    this.dataFile = dataFile
    this.state = undefined
    this.serial = Promise.resolve()
    this.ready = this.load()
    this.lastKnownMtime = null
    this.externalModWarned = false
    this.lockWarned = false
    this.dirty = false
    this.flushTimer = null
  }

  async list() {
    await this.ready
    return this.state.workspaces.map(workspace => this.summary(workspace))
  }

  async get(workspaceId) {
    await this.ready
    const workspace = this.workspace(workspaceId)
    return structuredClone(workspace)
  }

  /**
   * Read-only lookup used by on-demand body loading: returns the live thread
   * (no clone) together with its workspace, or null when the id is unknown.
   */
  async locateThread(threadId) {
    await this.ready
    for (const workspace of this.state.workspaces) {
      for (const thread of workspace.threads ?? []) {
        if (thread.id === threadId) return { workspace, thread }
      }
    }
    return null
  }

  async create(title) {
    return this.mutate(() => {
      const now = new Date().toISOString()
      const workspace = { id: randomUUID(), title: requiredText(title, MAX_TITLE_LENGTH, 'title'), createdAt: now, updatedAt: now, threads: [] }
      this.state.workspaces.unshift(workspace)
      return this.summary(workspace)
    })
  }

  async createThread(workspaceId, input) {
    return this.mutate(() => {
      const workspace = this.workspace(workspaceId)
      const now = new Date().toISOString()
      const thread = this.thread({
        title: input?.title,
        parentId: input?.parentId,
        dshSessionId: input?.dshSessionId,
        dshSessionTitle: input?.dshSessionTitle,
        position: input?.position,
        color: input?.color,
        now,
        order: workspace.threads.length,
      })
      if (thread.parentId !== null && !workspace.threads.some(item => item.id === thread.parentId)) throw new InputError('分支来源不存在')
      workspace.threads.push(thread)
      workspace.updatedAt = now
      return structuredClone(thread)
    })
  }

  async branch(threadId, input) {
    return this.mutate(() => {
      const { workspace, thread: parent } = this.locateThread(threadId)
      const now = new Date().toISOString()
      const sessionId = typeof input?.dshSessionId === 'string' && input.dshSessionId.length > 0 ? input.dshSessionId : null
      // A DSH fork emits session/created while the browser receives its fork
      // response. Either path may win the race, but both must resolve to one node.
      if (sessionId !== null) {
        const existing = workspace.threads.find(item => item.dshSessionId === sessionId)
        if (existing !== undefined) {
          existing.parentId ??= parent.id
          if (typeof input?.title === 'string' && input.title.trim() !== '') existing.title = requiredText(input.title, MAX_TITLE_LENGTH, 'title')
          if (typeof input?.dshSessionTitle === 'string') existing.dshSessionTitle = input.dshSessionTitle.slice(0, MAX_TITLE_LENGTH)
          existing.updatedAt = now
          workspace.updatedAt = now
          return structuredClone(existing)
        }
      }
      const siblings = workspace.threads.filter(item => item.parentId === parent.id)
      const thread = this.thread({
        title: input?.title,
        parentId: parent.id,
        dshSessionId: input?.dshSessionId,
        dshSessionTitle: input?.dshSessionTitle,
        position: input?.position ?? { x: parent.position.x + 420, y: parent.position.y + siblings.length * 248 },
        color: input?.color ?? parent.color,
        now,
        order: workspace.threads.length,
      })
      workspace.threads.push(thread)
      workspace.updatedAt = now
      return structuredClone(thread)
    })
  }

  /** Keep only the canvas graph in Synapse; DSH remains the source of session truth. */
  async syncSessions(sessions, removedSessionIds = []) {
    return this.mutate(() => {
      if (!Array.isArray(sessions)) throw new InputError('sessions 必须是数组')
      if (!Array.isArray(removedSessionIds) || removedSessionIds.some(item => typeof item !== 'string')) throw new InputError('removedSessionIds 必须是字符串数组')
      const blankIds = new Set(sessions.filter(item => item?.blank === true && typeof item.id === 'string').map(item => item.id))
      const removedIds = new Set(removedSessionIds)
      for (const workspace of this.state.workspaces) {
        if (workspace.kind !== 'dsh') continue
        workspace.threads = workspace.threads.filter(thread => !blankIds.has(thread.dshSessionId) && !removedIds.has(thread.dshSessionId))
      }
      this.state.workspaces = this.state.workspaces.filter(workspace => workspace.kind !== 'dsh' || workspace.threads.length > 0)
      for (const item of sessions) {
        if (typeof item?.id !== 'string' || item.id === '' || typeof item.cwd !== 'string' || item.cwd === '') continue
        if (item.blank === true) continue
        // Canvas archiving is persistent UI state. A normal DSH list refresh
        // must not recreate a session that the user deliberately archived.
        if (this.state.hiddenSessionIds.includes(item.id)) continue
        const workspace = this.dshWorkspace(item.cwd, 'DSH 任务')
        const session = { id: item.id, header: { meta: { cwd: item.cwd }, parentSession: typeof item.parentId === 'string' ? item.parentId : undefined }, title: typeof item.title === 'string' ? item.title : undefined, events: [] }
        const thread = this.dshThread(workspace, session)
        if (typeof item.title === 'string' && item.title.trim() !== '') {
          thread.title = item.title.slice(0, MAX_TITLE_LENGTH)
          thread.dshSessionTitle = thread.title
        }
      }
      return this.list()
    }, { deferred: true })
  }

  async addMessage(threadId, text) {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      const at = new Date().toISOString()
      const message = { id: randomUUID(), text: requiredText(text, MAX_NOTE_LENGTH, 'text'), kind: 'user', at }
      thread.messages.push(message)
      thread.updatedAt = at
      workspace.updatedAt = at
      return structuredClone(thread)
    })
  }

  async updateThread(threadId, input) {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      if (input?.title !== undefined) thread.title = requiredText(input.title, MAX_TITLE_LENGTH, 'title')
      if (input?.position !== undefined) thread.position = positionOf(input.position)
      thread.updatedAt = new Date().toISOString()
      workspace.updatedAt = thread.updatedAt
      return structuredClone(thread)
    })
  }

  async removeThread(threadId) {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      const removal = new Set([thread.id])
      for (let changed = true; changed;) {
        changed = false
        for (const item of workspace.threads) {
          if (item.parentId !== null && removal.has(item.parentId) && !removal.has(item.id)) { removal.add(item.id); changed = true }
        }
      }
      for (const item of workspace.threads) {
        if (removal.has(item.id) && item.dshSessionId !== null && !this.state.hiddenSessionIds.includes(item.dshSessionId)) this.state.hiddenSessionIds.push(item.dshSessionId)
      }
      workspace.threads = workspace.threads.filter(item => !removal.has(item.id))
      workspace.updatedAt = new Date().toISOString()
      if (workspace.threads.length === 0) this.state.workspaces = this.state.workspaces.filter(item => item.id !== workspace.id)
      return { removed: removal.size }
    })
  }

  async clearLegacy(sessions) {
    return this.mutate(() => {
      const hidden = new Set(this.state.hiddenSessionIds)
      for (const workspace of this.state.workspaces) for (const thread of workspace.threads) if (thread.dshSessionId !== null) hidden.add(thread.dshSessionId)
      for (const session of sessions) hidden.add(session.id)
      this.state.hiddenSessionIds = [...hidden]
      this.state.workspaces = []
      return { cleared: true }
    })
  }

  /** Replay one live DSH session into the dedicated projection workspace. */
  async projectSession(session, replayFrom = 0, workspaceTitle = 'DSH 任务') {
    return this.mutate(() => {
      if (this.state.hiddenSessionIds.includes(session.id)) return null
      const workspace = this.dshWorkspace(sessionCwd(session), workspaceTitle)
      const thread = this.dshThread(workspace, session)
      // `snapshotEvents()` replaces the removed `session.events` getter. It is
      // marked deprecated because DSH is moving complete logs out of memory, but
      // rebuilding this canvas from history needs the full sequence and the
      // reader is the only complete-log access a plugin still has.
      for (const event of session.snapshotEvents()) {
        if (event.seq >= replayFrom) this.projectEventInto(workspace, thread, event)
      }
      return structuredClone(thread)
    }, { deferred: true })
  }

  /** Project one committed DSH session event. Repeated sequence numbers are ignored. */
  async projectEvent(session, event, workspaceTitle = 'DSH 任务') {
    return this.mutate(() => {
      if (this.state.hiddenSessionIds.includes(session.id)) return null
      const workspace = this.dshWorkspace(sessionCwd(session), workspaceTitle)
      const thread = this.dshThread(workspace, session)
      this.projectEventInto(workspace, thread, event)
      return structuredClone(thread)
    }, { deferred: true })
  }

  /** Project a batch of committed events for one session in a single write. */
  async projectEvents(session, events, workspaceTitle = 'DSH 任务') {
    if (events.length === 0) return null
    return this.mutate(() => {
      if (this.state.hiddenSessionIds.includes(session.id)) return null
      const workspace = this.dshWorkspace(sessionCwd(session), workspaceTitle)
      const thread = this.dshThread(workspace, session)
      for (const event of events) this.projectEventInto(workspace, thread, event)
      return structuredClone(thread)
    }, { deferred: true })
  }

  async load() {
    await mkdir(dirname(this.dataFile), { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.dataFile, 'utf8'))
      const { state, migrated } = normalizeState(parsed)
      this.state = state
      if (migrated) {
        // Dropping stored bodies is the one migration that cannot be undone by
        // re-projection alone, so keep the pre-v5 file next to the new one.
        if (Number(parsed?.version) < 5) await copyFile(this.dataFile, `${this.dataFile}.v4-backup`).catch(() => {})
        await this.save()
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Never "repair" this file. An unreadable workspaces.json is the only
        // copy of the canvas; restoring a backup over it (which an earlier
        // revision did) both discarded whatever the file still held and silently
        // rolled the map back to a snapshot of unknown age. Fail instead: the
        // store stays unloaded, `ready` rejects, every mutation refuses to run,
        // and the HTTP layer reports this exact message so the user learns which
        // file to repair.
        throw new Error(`synapse: cannot read ${this.dataFile}: ${error.message}`)
      }
      this.state = { version: 5, hiddenSessionIds: [], workspaces: [] }
      await this.save()
    }
  }

  async mutate(action, { deferred = false } = {}) {
    await this.ready
    const task = this.serial.then(async () => {
      const result = action()
      if (deferred) this.markDirty()
      else await this.save()
      return result
    })
    this.serial = task.catch(() => undefined)
    return task
  }

  /** Mark the state dirty and schedule one trailing flush for the window. */
  markDirty() {
    this.dirty = true
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, SAVE_DEBOUNCE_MS)
  }

  /** Persist the current state when dirty, ordered after in-flight mutations. */
  flush() {
    if (!this.dirty) return Promise.resolve()
    this.dirty = false
    const task = this.serial.then(() => this.save())
    this.serial = task.catch(() => undefined)
    return task
  }

  async save() {
    // Two dsh web instances sharing one profile clobber each other's canvas
    // state. Warn loudly instead of silently losing work; a live lock held by
    // another process or a file mtime that moved since our last write both
    // indicate a second writer.
    const before = await this.fileMtime()
    if (this.lastKnownMtime !== null && before !== null && before !== this.lastKnownMtime) {
      this.lastKnownMtime = before
      if (!this.externalModWarned) {
        this.externalModWarned = true
        process.stderr.write('synapse: workspaces.json 已被另一个 dsh web 实例修改，本实例的写入可能覆盖其更改——请只运行一个实例\n')
      }
    }
    await this.acquireLock()
    try {
      const temporaryFile = `${this.dataFile}.${process.pid}.tmp`
      await writeFile(temporaryFile, `${JSON.stringify(this.state)}\n`, 'utf8')
      await rename(temporaryFile, this.dataFile)
      this.lastKnownMtime = (await stat(this.dataFile)).mtimeMs
    } finally {
      await this.releaseLock()
    }
  }

  async fileMtime() {
    try { return (await stat(this.dataFile)).mtimeMs } catch { return null }
  }

  /** Take an exclusive cross-process lock, breaking a stale one; warn when a live process holds it. */
  async acquireLock() {
    const lockFile = `${this.dataFile}.lock`
    if (await this.tryAcquire(lockFile)) return
    if (await this.lockIsStale(lockFile)) {
      await unlink(lockFile).catch(() => {})
      if (await this.tryAcquire(lockFile)) return
    }
    if (!this.lockWarned) {
      this.lockWarned = true
      process.stderr.write('synapse: 另一个 dsh web 实例正在写入 workspaces.json——请只运行一个实例，否则画布数据可能互相覆盖\n')
    }
  }

  async tryAcquire(lockFile) {
    try {
      await writeFile(lockFile, `${process.pid}\n`, { flag: 'wx' })
      return true
    } catch {
      return false
    }
  }

  /** A lock is stale when its owner PID is gone or the lock file is older than the stale window. */
  async lockIsStale(lockFile) {
    try {
      const [content, stats] = await Promise.all([readFile(lockFile, 'utf8'), stat(lockFile)])
      const tooOld = Date.now() - stats.mtimeMs > LOCK_STALE_MS
      const pid = Number.parseInt(content, 10)
      if (!Number.isInteger(pid)) return tooOld
      if (pid === process.pid) return false
      try {
        process.kill(pid, 0)
        return tooOld
      } catch {
        return true
      }
    } catch {
      return false
    }
  }

  async releaseLock() {
    await unlink(`${this.dataFile}.lock`).catch(() => {})
  }

  workspace(workspaceId) {
    const workspace = this.state.workspaces.find(item => item.id === workspaceId)
    if (workspace === undefined) throw new NotFoundError('工作空间不存在')
    return workspace
  }

  locateThread(threadId) {
    for (const workspace of this.state.workspaces) {
      const thread = workspace.threads.find(item => item.id === threadId)
      if (thread !== undefined) return { workspace, thread }
    }
    throw new NotFoundError('节点不存在')
  }

  dshWorkspace(cwd, fallbackTitle) {
    let workspace = this.state.workspaces.find(item => item.kind === 'dsh' && item.cwd === cwd)
    if (workspace !== undefined) return workspace
    const now = new Date().toISOString()
    workspace = { id: randomUUID(), kind: 'dsh', cwd, title: workspaceTitle(cwd, fallbackTitle), createdAt: now, updatedAt: now, threads: [] }
    this.state.workspaces.unshift(workspace)
    return workspace
  }

  dshThread(workspace, session) {
    let thread = workspace.threads.find(item => item.dshSessionId === session.id)
    if (thread !== undefined) {
      if (typeof session.title === 'string' && session.title.trim() !== '') {
        const title = session.title.slice(0, MAX_TITLE_LENGTH)
        thread.title = title
        thread.dshSessionTitle = title
      }
      // `inheritedEventCount` is DSH's durable fork cut, the successor of the
      // removed `header.seedLength`. It survives restore, unlike `firstLiveSeq`.
      const seedLength = session.inheritedEventCount
      if (Number.isSafeInteger(seedLength) && seedLength >= 0) thread.sourceSeedLength = seedLength
      return thread
    }
    const parentSessionId = typeof session.header?.parentSession === 'string' ? session.header.parentSession : null
    const parent = parentSessionId === null ? undefined : workspace.threads.find(item => item.dshSessionId === parentSessionId)
    const siblings = workspace.threads.filter(item => item.sourceParentSessionId === parentSessionId)
    const now = new Date().toISOString()
    thread = {
      id: randomUUID(),
      title: typeof session.title === 'string' && session.title.trim() !== '' ? session.title.slice(0, MAX_TITLE_LENGTH) : (parent === undefined ? 'DSH 会话' : `${parent.title} 分支`),
      parentId: parent?.id ?? null,
      sourceParentSessionId: parentSessionId,
      sourceSeedLength: Number.isSafeInteger(session.inheritedEventCount) && session.inheritedEventCount >= 0 ? session.inheritedEventCount : null,
      dshSessionId: session.id,
      dshSessionTitle: typeof session.title === 'string' ? session.title.slice(0, MAX_TITLE_LENGTH) : null,
      color: TOPIC_COLORS[workspace.threads.length % TOPIC_COLORS.length],
      // DSH projection stores only a neutral semantic anchor. The visual map
      // lays out visible cards from the current conversation graph each render,
      // so old/archived session counts must never leak into future coordinates.
      position: parent === undefined ? { x: 86, y: 82 } : { x: parent.position.x + 400, y: parent.position.y },
      createdAt: now,
      updatedAt: now,
      messages: [],
      pendingProcess: [],
    }
    workspace.threads.push(thread)
    // A child may arrive before its parent during startup replay. Repair that
    // relation when the missing parent later reaches the projection.
    for (const child of workspace.threads) {
      if (child.sourceParentSessionId === session.id && child.parentId === null) child.parentId = thread.id
    }
    workspace.updatedAt = now
    return thread
  }

  projectEventInto(workspace, thread, event) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      thread.title = event.data.title.slice(0, MAX_TITLE_LENGTH)
      thread.dshSessionTitle = thread.title
      thread.updatedAt = new Date(event.time).toISOString()
      workspace.updatedAt = thread.updatedAt
      return
    }
    if (event.type === 'tool/call' || event.type === 'tool/result') {
      this.foldToolProcess(thread, event)
      workspace.updatedAt = thread.updatedAt
      return
    }
    const projection = projectableEvent(event)
    if (projection === null || thread.messages.some(message => message.sourceSeq === event.seq)) return
    const at = new Date(event.time).toISOString()
    const message = {
      id: randomUUID(),
      text: projection.text,
      length: projection.length,
      truncated: projection.truncated,
      kind: projection.kind,
      sourceSeq: event.seq,
      at,
      ...(projection.kind === 'assistant' || projection.kind === 'error'
        ? { turn: event.data?.turn, step: event.data?.step, process: [] }
        : {}),
    }
    this.attachPendingProcess(thread, message)
    thread.messages.push(message)
    thread.updatedAt = at
    workspace.updatedAt = at
    if (thread.dshSessionTitle === null && projection.kind === 'user') {
      thread.title = titleFromText(projection.text)
      thread.dshSessionTitle = thread.title
    }
  }

  /**
   * Fold one tool call or result into the assistant message of its own
   * turn/step, keyed by `callId`, so a tool invocation never becomes a
   * separate canvas card. If a tool result arrives before its associated
   * assistant/error message, retain it on the thread until that turn appears.
   */
  foldToolProcess(thread, event) {
    const at = new Date(event.time).toISOString()
    const data = event.data ?? {}
    const target = [...thread.messages].reverse().find(message =>
      (message.kind === 'assistant' || message.kind === 'error')
      && (message.turn === data.turn && message.step === data.step
        || message.turn === undefined && message.step === undefined))
    const process = target === undefined ? (thread.pendingProcess ??= []) : (target.process ??= [])
    const callId = String(event.type === 'tool/call' ? data.callId : data.message?.source?.callId ?? '')
    const entry = process.find(item => item.callId === callId)
    // Process records keep only identity and status: tool arguments and results
    // are the bulk of the old file (issue #42) and are reloaded on demand.
    if (event.type === 'tool/call') {
      if (entry === undefined) {
        process.push({ callId, turn: data.turn, step: data.step, name: data.name, status: 'pending' })
      } else {
        entry.name = data.name
      }
    } else {
      const failed = errorText(data.error) !== null
      if (entry === undefined) {
        process.push({ callId, turn: data.turn, step: data.step, name: '工具调用', status: failed ? 'failed' : 'done' })
      } else {
        entry.status = failed ? 'failed' : 'done'
        if (typeof entry.name !== 'string' || entry.name === '') entry.name = '工具调用'
      }
    }
    thread.updatedAt = at
  }

  attachPendingProcess(thread, message) {
    if (!Array.isArray(thread.pendingProcess) || thread.pendingProcess.length === 0 || !Array.isArray(message.process)) return
    const matching = thread.pendingProcess.filter(entry => entry.turn === message.turn && entry.step === message.step)
    if (matching.length === 0) return
    message.process.push(...matching.map(({ turn, step, ...entry }) => entry))
    thread.pendingProcess = thread.pendingProcess.filter(entry => entry.turn !== message.turn || entry.step !== message.step)
  }

  thread({ title, parentId, dshSessionId, dshSessionTitle, position, color, now, order }) {
    return {
      id: randomUUID(),
      title: requiredText(title, MAX_TITLE_LENGTH, 'title'),
      parentId: typeof parentId === 'string' && parentId.length > 0 ? parentId : null,
      dshSessionId: typeof dshSessionId === 'string' && dshSessionId.length > 0 ? dshSessionId : null,
      dshSessionTitle: typeof dshSessionTitle === 'string' ? dshSessionTitle.slice(0, MAX_TITLE_LENGTH) : null,
      color: TOPIC_COLORS.includes(color) ? color : TOPIC_COLORS[order % TOPIC_COLORS.length],
      position: positionOf(position ?? { x: 86 + (order % 3) * 410, y: 82 + Math.floor(order / 3) * 260 }),
      createdAt: now,
      updatedAt: now,
      messages: [],
      pendingProcess: [],
    }
  }

  summary(workspace) {
    return { id: workspace.id, kind: workspace.kind ?? 'manual', cwd: workspace.cwd ?? null, title: workspace.title, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt, threadCount: workspace.threads.length }
  }
}

class InputError extends Error {}
class NotFoundError extends Error {}

function normalizeState(value) {
  let migrated = false
  let state
  if ((value?.version === 2 || value?.version === 3 || value?.version === 4 || value?.version === 5) && Array.isArray(value.workspaces)) {
    const hiddenSessionIds = Array.isArray(value.hiddenSessionIds) ? value.hiddenSessionIds.filter(item => typeof item === 'string') : []
    migrated = value.version < 3 || !Array.isArray(value.hiddenSessionIds)
    const workspaces = value.workspaces.map(workspace => ({
      ...workspace,
      threads: Array.isArray(workspace.threads) ? workspace.threads.map(thread => {
        if (Array.isArray(thread.messages)) {
          const messages = thread.messages.filter(message => !isInjectedUserMessage(message))
          if (messages.length !== thread.messages.length) migrated = true
          return { ...thread, messages }
        }
        migrated = true
        const notes = Array.isArray(thread.notes) ? thread.notes : []
        const { notes: _notes, ...rest } = thread
        return { ...rest, messages: notes, pendingProcess: [] }
      }) : [],
    }))
    state = { ...value, version: value.version, hiddenSessionIds, workspaces }
  } else if (value?.version === 1 && Array.isArray(value.workspaces)) {
    const now = typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString()
    state = {
      version: 3,
      hiddenSessionIds: [],
      workspaces: value.workspaces.map((workspace, index) => {
        const events = Array.isArray(workspace.events) ? workspace.events : []
        const workspaceNow = typeof workspace.updatedAt === 'string' ? workspace.updatedAt : now
        return {
          id: typeof workspace.id === 'string' ? workspace.id : randomUUID(),
          title: typeof workspace.title === 'string' && workspace.title.trim() ? workspace.title : '未命名工作空间',
          createdAt: typeof workspace.createdAt === 'string' ? workspace.createdAt : workspaceNow,
          updatedAt: workspaceNow,
          threads: events.length === 0 ? [] : [{
            id: randomUUID(), title: workspace.title || '历史记录', parentId: null, dshSessionId: null, dshSessionTitle: null,
            color: TOPIC_COLORS[index % TOPIC_COLORS.length], position: { x: 86, y: 82 }, createdAt: workspaceNow, updatedAt: workspaceNow,
            messages: events.map(event => ({ id: typeof event.id === 'string' ? event.id : randomUUID(), text: String(event.text ?? ''), at: typeof event.at === 'string' ? event.at : workspaceNow })),
          }],
        }
      }),
    }
    migrated = true
  } else {
    throw new Error('expected Synapse data version 1, 2, 3, 4, or 5')
  }
  if (state.version < 4) {
    if (foldLegacyToolCards(state.workspaces)) migrated = true
    state.version = 4
    migrated = true
  }
  // v5 drops message bodies and tool payloads from the workspace file: they are
  // re-read from the DSH session log on demand. Existing bodies become previews.
  if (state.version < 5) {
    for (const workspace of state.workspaces) {
      for (const thread of workspace.threads ?? []) {
        if (Array.isArray(thread.messages)) thread.messages = thread.messages.map(toStoredMessage)
        if (Array.isArray(thread.pendingProcess)) thread.pendingProcess = thread.pendingProcess.map(toStoredProcess)
      }
    }
    state.version = 5
    migrated = true
  }
  return { state, migrated }
}

/** v4 message → v5 message: keep identity and a preview, drop the body. */
function toStoredMessage(message) {
  const normalized = typeof message?.text === 'string' ? message.text.trim() : ''
  const text = normalized === '' ? '' : excerptOf(normalized)
  const process = Array.isArray(message?.process) ? message.process.map(toStoredProcess) : message?.process
  return {
    ...message,
    text,
    length: normalized.length,
    truncated: text.length < normalized.length,
    ...(process === undefined ? {} : { process }),
  }
}

/** v4 process record → v5 record: keep identity and status, drop the payload. */
function toStoredProcess(entry) {
  if (entry === null || typeof entry !== 'object') return entry
  const { arguments: _arguments, result, error, ...rest } = entry
  const status = error !== null && error !== undefined && error !== ''
    ? 'failed'
    : result === null || result === undefined
      ? 'pending'
      : 'done'
  return { ...rest, status: typeof entry.status === 'string' ? entry.status : status }
}

/**
 * Fold v3-era standalone tool cards (kinds `tool` / `tool-result`) into the
 * preceding assistant message's `process` list, pairing each call with the
 * result that follows it in order, so every tool invocation lives in one
 * home: the assistant turn card.
 */
function foldLegacyToolCards(workspaces) {
  let changed = false
  for (const workspace of workspaces) {
    for (const thread of workspace.threads ?? []) {
      if (!Array.isArray(thread.messages)) continue
      const folded = []
      let assistant = null
      let pending = []
      for (const message of thread.messages) {
        if (message.kind === 'assistant') {
          assistant = message
          assistant.process ??= []
          pending = []
          folded.push(message)
          continue
        }
        if (message.kind !== 'tool' && message.kind !== 'tool-result') {
          folded.push(message)
          continue
        }
        if (assistant === null) {
          folded.push(message)
          continue
        }
        changed = true
        if (message.kind === 'tool') {
          const [name = '工具调用', ...argumentLines] = message.text.split('\n')
          const entry = { callId: `legacy-${assistant.process.length}`, name, arguments: argumentLines.join('\n'), result: null, error: null }
          pending.push(entry)
          assistant.process.push(entry)
        } else {
          const entry = pending.shift() ?? (() => {
            const orphan = { callId: `legacy-orphan-${assistant.process.length}`, name: '工具调用', arguments: null, result: null, error: null }
            assistant.process.push(orphan)
            return orphan
          })()
          entry.result = message.text
        }
      }
      thread.messages = folded
    }
  }
  return changed
}

function positionOf(value) {
  const x = Number(value?.x)
  const y = Number(value?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new InputError('position 必须包含有效坐标')
  return { x: Math.round(Math.max(-2000, Math.min(5000, x))), y: Math.round(Math.max(-2000, Math.min(5000, y))) }
}

function requiredText(value, maxLength, field) {
  if (typeof value !== 'string') throw new InputError(`${field} 必须是文本`)
  const text = value.trim()
  if (text.length === 0) throw new InputError(`${field} 不能为空`)
  if (text.length > maxLength) throw new InputError(`${field} 超过长度限制`)
  return text
}

/** Event → canvas message kind, or null when the event is not a message. */
function eventKind(event) {
  switch (event?.type) {
    case 'user/message': return 'user'
    case 'assistant/message': return 'assistant'
    case 'todo/write': return 'todo'
    case 'turn/end': {
      const reason = event.data?.reason
      if (reason?.kind === 'error') return 'error'
      if (reason?.kind === 'cancelled' || reason?.kind === 'canceled' || reason?.kind === 'aborted') return 'error'
      return null
    }
    default:
      return /(?:error|failed|failure|cancel(?:led)?|abort)/i.test(event?.type ?? '') ? 'error' : null
  }
}

/**
 * Full body of one event. Shared by the projection (which stores a preview) and
 * the on-demand loader (which returns the whole text), so both read the same
 * fields instead of keeping two parsers in step.
 */
function eventBody(event) {
  switch (event?.type) {
    case 'user/message': return contentText(event.data?.content)
    case 'assistant/message': return contentText(event.data?.message?.content)
    case 'todo/write': return Array.isArray(event.data?.todos) ? event.data.todos.map(todo => `[${todo.status}] ${todo.content}`).join('\n') : ''
    case 'turn/end': {
      const reason = event.data?.reason
      if (reason?.kind === 'error') return errorText(reason.error) ?? '本轮执行失败'
      return '本轮已取消'
    }
    default:
      return eventKind(event) === 'error' ? errorText(event.data?.error ?? event.data?.reason ?? event.data) ?? 'Harness 运行失败' : ''
  }
}

function projectableEvent(event) {
  const kind = eventKind(event)
  if (kind === null) return null
  const text = eventBody(event)
  if (kind === 'user' && (isInjectedUserSource(event.data?.source) || isRuntimeContextText(text))) return null
  return noteProjection(kind, text)
}

/**
 * Full bodies for the requested stored messages, assembled from one session's
 * event log. Exported so the on-demand loader is testable without a Host.
 * `seqs === null` returns every projected message of the thread.
 */
export function bodiesFromEvents(thread, events, seqs) {
  const wanted = seqs === null ? null : new Set(seqs)
  const messages = {}
  const eventsBySeq = new Map(events.map(event => [event?.seq, event]))
  const calls = new Map()
  for (const event of events) {
    if (event?.type !== 'tool/call' && event?.type !== 'tool/result') continue
    const callId = String(event.type === 'tool/call' ? event.data?.callId : event.data?.message?.source?.callId ?? '')
    if (callId === '') continue
    const record = calls.get(callId) ?? {}
    if (event.type === 'tool/call') {
      record.arguments = typeof event.data?.arguments === 'string' ? event.data.arguments : null
    } else {
      record.result = contentText(event.data?.message?.content) || null
      record.error = errorText(event.data?.error)
    }
    calls.set(callId, record)
  }
  for (const message of thread.messages ?? []) {
    if (wanted !== null && !wanted.has(message.sourceSeq)) continue
    const event = eventsBySeq.get(message.sourceSeq)
    if (event === undefined) continue
    const body = eventBody(event).trim()
    const capped = body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}${BODY_TRUNCATED_SUFFIX}` : body
    const process = Array.isArray(message.process)
      ? message.process.map(entry => ({ ...entry, ...(calls.get(String(entry.callId)) ?? {}) }))
      : []
    messages[String(message.sourceSeq)] = { text: capped, truncated: capped.length < body.length, process }
  }
  return messages
}

// ---------------------------------------------------------------------------
// Session logs on disk
//
// `ctx.sessions` only exposes sessions this process currently holds, which is
// one or two out of a workspace's history. Everything else is read from the DSH
// session log: a run of concatenated zstd frames holding JSONL events.
// ---------------------------------------------------------------------------

const SESSION_LOG_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSION_LOG_PATTERN = /^session(?:\.[\w-]+)*\.jsonl\.zstd$/

/** Decode the concatenated zstd frames of one session log into JSONL text. */
export function decodeSessionLog(buffer) {
  if (typeof zstdDecompressSync !== 'function') return null
  const offsets = []
  let index = buffer.indexOf(SESSION_LOG_MAGIC, 0)
  while (index !== -1) {
    offsets.push(index)
    index = buffer.indexOf(SESSION_LOG_MAGIC, index + 4)
  }
  if (offsets.length === 0) return null
  const parts = []
  for (let i = 0; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offsets[i], end)))
    } catch {
      // A log that is being appended to can end mid-frame; decode what is whole.
      break
    }
  }
  if (parts.length === 0) return null
  return Buffer.concat(parts).toString('utf8')
}

/** Reads session events from `$DSH_HOME/sessions`, caching by file mtime. */
export class SessionLogReader {
  constructor(directory) {
    this.directory = directory
    this.cache = new Map()
  }

  /** Events of one session, or null when its log is missing or unreadable. */
  async events(sessionId) {
    if (typeof this.directory !== 'string' || this.directory === '' || typeof sessionId !== 'string' || sessionId === '') return null
    const file = await this.findLog(sessionId)
    if (file === null) {
      this.cache.delete(sessionId)
      return null
    }
    const info = await stat(file).catch(() => null)
    if (info === null) return null
    const cached = this.cache.get(sessionId)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.events
    const text = decodeSessionLog(await readFile(file))
    if (text === null) return null
    const events = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const event = JSON.parse(line)
        if (typeof event?.seq === 'number') events.push(event)
      } catch {
        // Trailing partial line while the session is still being written.
      }
    }
    // Keep a few decoded logs; one screenful of cards touches few threads.
    if (this.cache.size >= 4) this.cache.delete(this.cache.keys().next().value)
    this.cache.set(sessionId, { mtimeMs: info.mtimeMs, size: info.size, events })
    return events
  }

  async findLog(sessionId) {
    let workspaces
    try {
      workspaces = await readdir(this.directory, { withFileTypes: true })
    } catch {
      return null
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue
      const sessionDirectory = join(this.directory, workspace.name, sessionId)
      let files
      try {
        files = await readdir(sessionDirectory)
      } catch {
        continue
      }
      const log = files.find(name => SESSION_LOG_PATTERN.test(name))
      if (log !== undefined) return join(sessionDirectory, log)
    }
    return null
  }
}

function errorText(value) {
  if (typeof value === 'string') return value.trim() || null
  if (value === null || value === undefined || typeof value !== 'object') return null
  const name = typeof value.name === 'string' && value.name.trim() !== '' ? value.name.trim() : ''
  const code = typeof value.code === 'string' && value.code.trim() !== '' ? value.code.trim() : ''
  const message = typeof value.message === 'string' && value.message.trim() !== '' ? value.message.trim() : ''
  if (message !== '') return [name, code].filter(Boolean).concat(message).join(': ')
  return [name, code].filter(Boolean).join(': ') || null
}

function noteProjection(kind, text) {
  const normalized = text.trim()
  if (normalized === '') return null
  const excerpt = excerptOf(normalized)
  return { kind, text: excerpt, length: normalized.length, truncated: excerpt.length < normalized.length }
}

/** Short preview kept in the workspace file, with an ellipsis when cut. */
function excerptOf(text) {
  if (text.length <= EXCERPT_CHARS) return text
  return `${text.slice(0, EXCERPT_CHARS).trimEnd()}…`
}

function isRuntimeContextText(text) {
  return typeof text === 'string' && text.trimStart().startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')
}

function isRuntimeContextMessage(message) {
  return message?.kind === 'user' && isRuntimeContextText(message.text)
}

/** A harness-authored turn, identified by its structured provenance. */
function isInjectedUserSource(source) {
  return typeof source?.kind === 'string' && INJECTED_USER_SOURCE_KINDS.has(source.kind)
}

/**
 * Recognises a stored skill catalogue. Only the harness emits both markers
 * together, so a person quoting one of them is still kept as a real turn.
 */
function isSkillCatalogText(text) {
  if (typeof text !== 'string') return false
  const head = text.trimStart()
  return head.startsWith(SKILL_CATALOG_OPENER) && head.includes(SKILL_CATALOG_MARKER)
}

/**
 * Whether a stored message must stay out of the canvas graph: runtime
 * snapshots and skill catalogues were never a turn the user took.
 */
function isInjectedUserMessage(message) {
  return message?.kind === 'user' && (isRuntimeContextMessage(message) || isSkillCatalogText(message.text))
}

function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    if (block?.type === 'text') return [block.text]
    if (block?.type === 'tool-call') return [block.name, block.arguments]
    if (block?.type === 'tool-result') return contentText(block.content)
    return []
  }).filter(value => typeof value === 'string' && value.trim() !== '').join('\n')
}

function titleFromText(text) {
  const line = text.replaceAll(/\s+/g, ' ').trim()
  return (line.length > 42 ? `${line.slice(0, 42)}...` : line) || 'DSH 会话'
}

function sessionCwd(session) {
  // The Session header defines `cwd` as its only working-directory carrier; the
  // old `header.meta.cwd` fallback never matched a real header field.
  const cwd = session.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : '未指定工作目录'
}

function workspaceTitle(cwd, fallbackTitle) {
  if (cwd === '未指定工作目录') return fallbackTitle
  const segment = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)
  return segment && segment.trim() !== '' ? segment : fallbackTitle
}

async function readJson(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > MAX_BODY_BYTES) throw new InputError('请求内容过大')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new InputError('请求不是有效 JSON') }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendFile(res, contentType, body) {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
  res.end(body)
}

const UUID_POLYFILL = '<script>if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") { crypto.randomUUID = function () { return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) { var r = (Math.random() * 16) | 0; var v = c === "x" ? r : (r & 0x3) | 0x8; return v.toString(16) }) } }</script>'

function page() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synapse for DSH</title><link rel="stylesheet" href="/synapse/styles.css">${UUID_POLYFILL}</head><body><div id="app"></div><script src="/synapse/app.js?v=2026082119"></script></body></html>`
}

/** Mount Synapse routes on the existing DSH Web Server. */
export function apply(ctx, config) {
  const store = new WorkspaceStore(config?.dataFile)
  // A profile can point the plugin at a different home; by default the session
  // logs sit beside the workspace file ($DSH_HOME/sessions).
  const sessionsDirectory = typeof config?.sessionsDir === 'string' && config.sessionsDir !== ''
    ? config.sessionsDir
    : join(dirname(dirname(config?.dataFile ?? '')), 'sessions')
  const sessionLog = new SessionLogReader(sessionsDirectory)
  const autoProjection = config?.autoProjection !== false
  const projectionWorkspaceTitle = typeof config?.projectionWorkspaceTitle === 'string' && config.projectionWorkspaceTitle.trim() !== ''
    ? config.projectionWorkspaceTitle.trim().slice(0, MAX_TITLE_LENGTH)
    : 'DSH 任务'
  const reportProjectionFailure = error => {
    ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
  }
  const replaySession = session => {
    // Forks inherit their parent's log. The canvas already represents that
    // history through the parent node, so only project the child's live tail:
    // `inheritedEventCount` is 0 without a fork and the durable cut with one.
    const replayFrom = session.inheritedEventCount ?? 0
    void store.projectSession(session, replayFrom, projectionWorkspaceTitle).catch(reportProjectionFailure)
  }
  // Buffer live events per session and flush them in one write per microtask,
  // so a burst of turn events coalesces into a single save instead of N.
  const projectionQueue = []
  let projectionScheduled = false
  const enqueueProjection = (session, event) => {
    projectionQueue.push({ session, event })
    if (projectionScheduled) return
    projectionScheduled = true
    queueMicrotask(() => {
      projectionScheduled = false
      const batch = projectionQueue.splice(0)
      const bySession = new Map()
      for (const item of batch) {
        const entry = bySession.get(item.session.id)
        if (entry === undefined) bySession.set(item.session.id, [item.session, [item.event]])
        else entry[1].push(item.event)
      }
      for (const [sessionId, [session, events]] of bySession) {
        void store.projectEvents(session, events, projectionWorkspaceTitle).catch(reportProjectionFailure)
      }
    })
  }
  if (autoProjection) {
    ctx.on('session/created', replaySession)
    ctx.on('session/event', enqueueProjection)
    for (const session of ctx.sessions.list()) replaySession(session)
  }
  // Bodies live in the session log, not in the workspace file (issue #42). The
  // canvas pulls them for the cards it actually renders; the detail view pulls a
  // whole thread at once. An archived or already-removed session cannot be
  // re-read, so the caller is told instead of receiving silently empty text.
  const threadBodies = async (threadId, seqs) => {
    const located = await store.locateThread(threadId)
    if (located === null) throw new NotFoundError('会话不存在')
    const { thread } = located
    const wanted = seqs === null ? null : new Set(seqs)
    if (thread.dshSessionId === null) {
      const messages = {}
      for (const message of thread.messages ?? []) {
        if (wanted !== null && !wanted.has(message.sourceSeq)) continue
        messages[String(message.sourceSeq)] = { text: message.text, truncated: message.truncated === true, process: message.process ?? [], local: true }
      }
      return { messages }
    }
    const session = ctx.sessions.list().find(candidate => candidate.id === thread.dshSessionId)
    if (session !== undefined) return { messages: bodiesFromEvents(thread, session.snapshotEvents(), seqs) }
    // Closed session: read its log from disk, which is where the body lives.
    const events = await sessionLog.events(thread.dshSessionId)
    if (events === null) return { messages: {}, unavailable: true }
    return { messages: bodiesFromEvents(thread, events, seqs) }
  }
  // The DSH /api browser-trust fence does not cover /synapse routes, so this
  // handler checks the Host header itself: localhost is allowed by default and
  // additional authorities opt in through config.trustedHosts (mirrors the
  // fence's DNS-rebinding defense).
  const trustedHosts = new Set(['localhost', '127.0.0.1', ...[...(config?.trustedHosts ?? [])].map(host => String(host).trim().toLowerCase()).filter(Boolean)])
  const api = async (req, res) => {
    try {
      const hostname = (typeof req.headers.host === 'string' ? req.headers.host : '').replace(/:\d+$/, '').toLowerCase()
      if (!trustedHosts.has(hostname)) return sendJson(res, 403, { error: '不被信任的 Host' })
      const path = new URL(req.url ?? '/', 'http://dsh.local').pathname
      if (path === '/synapse/api/reset' && req.method === 'POST') return sendJson(res, 200, await store.clearLegacy(ctx.sessions.list()))
      if (path === '/synapse/api/workspaces') {
        if (req.method === 'GET') return sendJson(res, 200, { workspaces: await store.list() })
        if (req.method === 'POST') return sendJson(res, 201, { workspace: await store.create((await readJson(req)).title) })
      }
      const workspace = /^\/synapse\/api\/workspaces\/([0-9a-f-]+)$/i.exec(path)
      if (workspace !== null) {
        if (req.method === 'GET') return sendJson(res, 200, { workspace: await store.get(workspace[1]) })
        if (req.method === 'POST') return sendJson(res, 201, { thread: await store.createThread(workspace[1], await readJson(req)) })
      }
      const branch = /^\/synapse\/api\/threads\/([0-9a-f-]+)\/branch$/i.exec(path)
      if (branch !== null && req.method === 'POST') return sendJson(res, 201, { thread: await store.branch(branch[1], await readJson(req)) })
      if (path === '/synapse/api/sessions/sync' && req.method === 'POST') { const body = await readJson(req); return sendJson(res, 200, { workspaces: await store.syncSessions(body.sessions, body.removedSessionIds) }) }
      const messages = /^\/synapse\/api\/threads\/([0-9a-f-]+)\/messages$/i.exec(path)
      if (messages !== null && req.method === 'POST') return sendJson(res, 201, { thread: await store.addMessage(messages[1], (await readJson(req)).text) })
      const full = /^\/synapse\/api\/threads\/([0-9a-f-]+)\/full$/i.exec(path)
      if (full !== null && req.method === 'GET') {
        const raw = new URL(req.url ?? '/', 'http://dsh.local').searchParams.get('seqs')
        const seqs = raw === null || raw.trim() === ''
          ? null
          : raw.split(',').map(value => Number.parseInt(value, 10)).filter(value => Number.isInteger(value) && value >= 0)
        return sendJson(res, 200, await threadBodies(full[1], seqs))
      }
      const thread = /^\/synapse\/api\/threads\/([0-9a-f-]+)$/i.exec(path)
      if (thread !== null && req.method === 'PATCH') return sendJson(res, 200, { thread: await store.updateThread(thread[1], await readJson(req)) })
      if (thread !== null && req.method === 'DELETE') return sendJson(res, 200, await store.removeThread(thread[1]))
      return sendJson(res, 404, { error: '接口不存在' })
    } catch (error) {
      if (error instanceof InputError) return sendJson(res, 400, { error: error.message })
      if (error instanceof NotFoundError) return sendJson(res, 404, { error: error.message })
      ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
      // A store that cannot read its file carries the only actionable detail —
      // the path. Passing it through beats a generic banner the user cannot act
      // on, and it is the one failure the canvas must never paper over.
      const unreadable = error instanceof Error && error.message.startsWith('synapse: cannot read')
      return sendJson(res, 500, { error: unreadable ? error.message : 'Synapse 数据暂时不可用' })
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/synapse', handler: (_req, res) => { res.writeHead(302, { location: '/synapse/' }); res.end() } }), 'synapse: redirect')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/synapse/', handler: (_req, res) => { sendFile(res, 'text/html; charset=utf-8', page()) } }), 'synapse: page')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/synapse/app.js', handler: async (_req, res) => { sendFile(res, 'text/javascript; charset=utf-8', await readFile(new URL('./app.js', import.meta.url), 'utf8')) } }), 'synapse: app')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/synapse/styles.css', handler: async (_req, res) => { sendFile(res, 'text/css; charset=utf-8', await readFile(new URL('./styles.css', import.meta.url), 'utf8')) } }), 'synapse: styles')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/synapse/deepseek-mark.svg', handler: async (_req, res) => { sendFile(res, 'image/svg+xml', await readFile(new URL('./deepseek-mark.svg', import.meta.url), 'utf8')) } }), 'synapse: DeepSeek mark')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/synapse/api', handler: api }), 'synapse: api')
}
