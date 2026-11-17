// Browser-only helpers, with no dependency on DSH or a DOM. Byte accounting
// uses UTF-16 string storage plus object/key allowances, not exact heap size.
const SynapseCache = (() => {
  const LIMITS = Object.freeze({
    bodyBytes: 16 * 1024 * 1024, bodyEntries: 512,
    markdownBytes: 4 * 1024 * 1024, markdownEntries: 256,
    markdownEntryBytes: 512 * 1024, requests: 2, batch: 20, wanted: 256,
  })
  const textBytes = value => typeof value === 'string' ? value.length * 2 : 0
  const messageKey = (threadId, seq) => `${threadId}:${seq}`

  // A world-space grid keeps camera moves proportional to nearby regions,
  // rather than to the number of cards in the entire conversation history.
  class RegionIndex {
    constructor(cellSize = 1024, width = 310, height = 276) {
      this.cellSize = cellSize
      this.width = width
      this.height = height
      this.cells = new Map()
      this.keysById = new Map()
      this.items = new Map()
    }
    cellKeys(bounds) {
      const keys = []
      const left = Math.floor(bounds.left / this.cellSize)
      const right = Math.floor(bounds.right / this.cellSize)
      const top = Math.floor(bounds.top / this.cellSize)
      const bottom = Math.floor(bounds.bottom / this.cellSize)
      if (![left, right, top, bottom].every(Number.isSafeInteger) || (right - left + 1) * (bottom - top + 1) > 65536) return keys
      for (let x = left; x <= right; x++) {
        for (let y = top; y <= bottom; y++) keys.push(`${x},${y}`)
      }
      return keys
    }
    set(item) {
      this.delete(item.id)
      const { x, y } = item.position
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      const keys = this.cellKeys({ left: x, right: x + this.width, top: y, bottom: y + this.height })
      for (const key of keys) {
        if (!this.cells.has(key)) this.cells.set(key, new Set())
        this.cells.get(key).add(item.id)
      }
      this.keysById.set(item.id, keys)
      this.items.set(item.id, item)
    }
    delete(id) {
      for (const key of this.keysById.get(id) ?? []) {
        const cell = this.cells.get(key)
        cell.delete(id)
        if (cell.size === 0) this.cells.delete(key)
      }
      this.keysById.delete(id)
      this.items.delete(id)
    }
    query(bounds) {
      const ids = new Set()
      const found = []
      for (const key of this.cellKeys(bounds)) {
        for (const id of this.cells.get(key) ?? []) {
          if (ids.has(id)) continue
          ids.add(id)
          const item = this.items.get(id)
          const { x, y } = item.position
          if (x + this.width < bounds.left || x > bounds.right || y + this.height < bounds.top || y > bounds.bottom) continue
          found.push(item)
        }
      }
      return found
    }
  }

  class ByteLru {
    constructor(maxBytes, maxEntries) {
      this.maxBytes = maxBytes
      this.maxEntries = maxEntries
      this.bytes = 0
      this.entries = new Map()
    }
    get size() { return this.entries.size }
    has(key) { return this.entries.has(key) }
    peek(key) { return this.entries.get(key)?.value }
    get(key) {
      const entry = this.entries.get(key)
      if (!entry) return undefined
      this.entries.delete(key)
      this.entries.set(key, entry)
      return entry.value
    }
    set(key, value, size, owner) {
      this.delete(key)
      const bytes = size + textBytes(key) + 128
      if (!Number.isFinite(bytes) || bytes > this.maxBytes || this.maxEntries <= 0) return false
      while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.delete(this.entries.keys().next().value)
      this.entries.set(key, { value, bytes, owner })
      this.bytes += bytes
      return true
    }
    delete(key) {
      const entry = this.entries.get(key)
      if (entry) this.bytes -= entry.bytes
      return this.entries.delete(key)
    }
    retainOwners(owners) {
      for (const [key, entry] of this.entries) if (!owners.has(entry.owner)) this.delete(key)
    }
    clear() { this.entries.clear(); this.bytes = 0 }
  }

  function bodyBytes(payload) {
    let bytes = 256
    for (const field of ['text', 'reason']) bytes += textBytes(payload[field])
    for (const entry of payload.process ?? []) {
      bytes += 192
      for (const field of ['callId', 'name', 'status', 'arguments', 'result', 'error']) bytes += textBytes(entry[field])
    }
    return bytes
  }

  class BodyCache {
    constructor(maxBytes = LIMITS.bodyBytes, maxEntries = LIMITS.bodyEntries) {
      this.lru = new ByteLru(maxBytes, maxEntries)
    }
    get bytes() { return this.lru.bytes }
    get size() { return this.lru.size }
    get(threadId, seq, revision) {
      const key = messageKey(threadId, seq)
      const entry = this.lru.peek(key)
      if (entry && entry.revision !== revision) { this.lru.delete(key); return undefined }
      return this.lru.get(key)?.payload
    }
    set(threadId, seq, revision, payload) {
      return this.lru.set(messageKey(threadId, seq), { revision, payload }, bodyBytes(payload) + textBytes(revision), threadId)
    }
    retainThreads(ids) { this.lru.retainOwners(ids) }
    clear() { this.lru.clear() }
  }

  /** Keep wanted/attempt/failure metadata bounded to the current screen.
   * Failed or evicted wanted entries get one attempt per visit. This prevents
   * an oversized viewport from fetching and evicting itself forever.
   */
  class BodyLoader {
    constructor({ cache, request, onUpdate = () => {}, concurrency = LIMITS.requests, batch = LIMITS.batch, maxWanted = LIMITS.wanted }) {
      this.cache = cache
      this.request = request
      this.onUpdate = onUpdate
      this.concurrency = concurrency
      this.batch = batch
      this.maxWanted = maxWanted
      this.wanted = new Map()
      this.attempted = new Set()
      this.failures = new Set()
      this.jobs = new Set()
      this.waiters = []
      this.viewKey = null
    }
    sync(messages, viewKey = this.viewKey) {
      if (viewKey !== this.viewKey) {
        this.attempted.clear()
        this.failures.clear()
        this.viewKey = viewKey
      }
      const next = new Map()
      for (const message of messages) {
        if (next.size >= this.maxWanted) break
        const key = messageKey(message.threadId, message.seq)
        if (next.has(key)) continue
        const previous = this.wanted.get(key)
        const entry = previous?.revision === message.revision ? previous : { ...message, key }
        entry.priority = message.priority
        next.set(key, entry)
      }
      for (const [key, previous] of this.wanted) {
        if (next.get(key) !== previous) { this.attempted.delete(key); this.failures.delete(key) }
      }
      this.wanted = next
      for (const job of [...this.jobs]) if (job.entries.some(entry => !this.current(entry))) this.cancel(job)
      // Opening the inspector may interrupt speculative nearby requests.
      // Reserve a request slot for its missing body instead of waiting behind
      // two background batches.
      const urgent = [...next.values()].some(entry => entry.priority === 0 && this.cache.get(entry.threadId, entry.seq, entry.revision) === undefined
        && !this.attempted.has(entry.key) && ![...this.jobs].some(job => job.entries.includes(entry)))
      if (urgent && this.jobs.size >= this.concurrency) {
        const background = [...this.jobs].find(job => job.entries.every(entry => entry.priority !== 0))
        if (background) this.cancel(background)
      }
      for (const job of this.jobs) for (const entry of job.entries) this.attempted.add(entry.key)
      this.pump()
    }
    current(entry) { return this.wanted.get(entry.key) === entry }
    cancel(job) {
      this.jobs.delete(job)
      job.controller.abort()
      for (const entry of job.entries) {
        if (this.current(entry) && this.cache.get(entry.threadId, entry.seq, entry.revision) === undefined) this.attempted.delete(entry.key)
      }
    }
    pause({ clearCache = false } = {}) {
      this.wanted.clear()
      this.attempted.clear()
      this.failures.clear()
      this.viewKey = null
      for (const job of [...this.jobs]) this.cancel(job)
      if (clearCache) this.cache.clear()
      this.settleIdle()
    }
    retainThreads(ids) {
      this.cache.retainThreads(ids)
      this.sync([...this.wanted.values()].filter(entry => ids.has(entry.threadId)))
    }
    unavailable(threadId, seq, revision) {
      const key = messageKey(threadId, seq)
      return this.failures.has(key) || (this.attempted.has(key) && this.cache.get(threadId, seq, revision) === undefined && ![...this.jobs].some(job => job.entries.some(entry => entry.key === key)))
    }
    retry() {
      for (const entry of this.wanted.values()) {
        if (this.cache.get(entry.threadId, entry.seq, entry.revision) !== undefined) continue
        if ([...this.jobs].some(job => job.entries.includes(entry))) continue
        this.attempted.delete(entry.key)
        this.failures.delete(entry.key)
      }
      this.pump()
    }
    pump() {
      while (this.jobs.size < this.concurrency) {
        const entries = []
        for (const entry of this.wanted.values()) {
          if (this.attempted.has(entry.key) || this.cache.get(entry.threadId, entry.seq, entry.revision) !== undefined) continue
          if (entries.length > 0 && entries[0].threadId !== entry.threadId) continue
          entries.push(entry)
          if (entries.length === this.batch) break
        }
        if (entries.length === 0) break
        const job = { entries, controller: new AbortController() }
        for (const entry of entries) this.attempted.add(entry.key)
        this.jobs.add(job)
        void this.run(job)
      }
      this.settleIdle()
    }
    async run(job) {
      let changed = false
      try {
        let cursor = 0
        while (this.jobs.has(job) && !job.controller.signal.aborted) {
          const threadId = job.entries[0].threadId
          const seqs = job.entries.map(entry => entry.seq)
          const response = await this.request(`/synapse/api/threads/${threadId}/full?seqs=${seqs.join(',')}&cursor=${cursor}&limit=${this.batch}`, job.controller.signal)
          if (!this.jobs.has(job) || job.controller.signal.aborted) return
          for (const [seq, payload] of Object.entries(response.messages ?? {})) {
            const entry = job.entries.find(item => item.seq === Number(seq))
            if (!entry || !this.current(entry) || payload === null || typeof payload !== 'object') continue
            this.cache.set(threadId, entry.seq, entry.revision, payload)
            changed = true
          }
          if (response.nextCursor === null || response.nextCursor === undefined) break
          if (!Number.isSafeInteger(response.nextCursor) || response.nextCursor <= cursor || response.nextCursor >= seqs.length) throw new Error('正文分页游标无效')
          cursor = response.nextCursor
        }
        for (const entry of job.entries) {
          if (this.current(entry) && this.cache.get(entry.threadId, entry.seq, entry.revision) === undefined) { this.failures.add(entry.key); changed = true }
        }
      } catch {
        if (this.jobs.has(job) && !job.controller.signal.aborted) {
          for (const entry of job.entries) {
            if (this.current(entry) && this.cache.get(entry.threadId, entry.seq, entry.revision) === undefined) { this.failures.add(entry.key); changed = true }
          }
        }
      } finally {
        const currentJob = this.jobs.delete(job)
        this.pump()
        if (currentJob && changed) this.onUpdate(job.entries)
      }
    }
    idle() {
      if (this.jobs.size === 0) return Promise.resolve()
      return new Promise(resolve => this.waiters.push(resolve))
    }
    settleIdle() {
      if (this.jobs.size === 0) for (const resolve of this.waiters.splice(0)) resolve()
    }
  }

  return { LIMITS, RegionIndex, ByteLru, BodyCache, BodyLoader, textBytes }
})()
