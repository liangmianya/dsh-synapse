import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { constants, zstdDecompress, zstdDecompressSync } from 'node:zlib'
import { promisify } from 'node:util'

const KiB = 1024
export const BODY_LIMITS = Object.freeze({
  pageMessages: 20, selectors: 40, responseBytes: 512 * KiB,
  messageBytes: 128 * KiB, textBytes: 64 * KiB, toolFieldBytes: 8 * KiB,
  processBytes: 64 * KiB, processEntries: 12,
})
export const LOG_LIMITS = Object.freeze({
  compressedBytes: 8 * KiB * KiB, decodedBytes: 32 * KiB * KiB,
  frameBytes: 8 * KiB * KiB, lineBytes: 2 * KiB * KiB,
  cacheBytes: 8 * KiB * KiB, cacheEntries: 4, concurrency: 2, pendingReads: 16,
})
const TRUNCATED_SUFFIX = '\n——…（内容过长，其余请在 DSH 中查看）'
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
// V8 slices/ropes can keep the original large JSON line alive. Retained text
// must own a small backing allocation, even when it looks like a short preview.
const ownString = value => Buffer.from(value, 'utf8').toString('utf8')

export class LogLimitError extends Error {
  constructor(kind) { super(`会话日志超出读取上限（${kind}），请在 DSH 中查看全文`); this.name = 'LogLimitError' }
}

/** Cap serialized UTF-8 too: control characters can cost six JSON bytes each. */
function boundedString(value, bytes, alreadyTruncated = false) {
  if (typeof value !== 'string') return { text: '', truncated: alreadyTruncated }
  let end = Math.min(value.length, bytes)
  const prefix = value.slice(0, end)
  if (!alreadyTruncated && end === value.length && jsonBytes(prefix) <= bytes) return { text: ownString(prefix), truncated: false }
  const budget = Math.max(2, bytes - jsonBytes(TRUNCATED_SUFFIX))
  let low = 0
  let high = end
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (jsonBytes(value.slice(0, mid)) <= budget) low = mid
    else high = mid - 1
  }
  end = low
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1
  return { text: ownString(value.slice(0, end).trimEnd() + TRUNCATED_SUFFIX), truncated: true }
}

/** Walk nested tool results without recursion or building a full-size join. */
function boundedContent(content, bytes, textOnly = false) {
  const parts = []
  let chars = 0
  let visited = 0
  let truncated = false
  const append = value => {
    if (typeof value !== 'string' || value === '') return
    const room = bytes - chars
    if (room <= 0) { truncated = true; return }
    const part = value.slice(0, room)
    parts.push(part)
    chars += part.length + 1
    if (part.length < value.length) truncated = true
  }
  const stack = Array.isArray(content) ? [{ array: content, index: 0 }] : []
  while (stack.length > 0) {
    const frame = stack.at(-1)
    if (frame.index >= frame.array.length) { stack.pop(); continue }
    if (chars >= bytes || ++visited > 2048) { truncated = true; break }
    const block = frame.array[frame.index++]
    if (block?.type === 'text') append(block.text)
    else if (!textOnly && block?.type === 'tool-call') { append(block.name); append(block.arguments) }
    else if (!textOnly && block?.type === 'tool-result' && Array.isArray(block.content)) {
      if (stack.length >= 32) truncated = true
      else stack.push({ array: block.content, index: 0 })
    }
  }
  return boundedString(parts.join('\n').trim(), bytes, truncated)
}

function boundedError(value, bytes) {
  if (typeof value === 'string') return boundedString(value, bytes)
  if (value === null || typeof value !== 'object') return { text: '', truncated: false }
  const fields = [value.name, value.code, value.message].filter(field => typeof field === 'string' && field !== '')
  return boundedString(fields.map(field => field.slice(0, bytes)).join(': '), bytes, fields.some(field => field.length > bytes))
}

function bodyOf(event) {
  if (typeof event?.synapseBody === 'string') return { text: event.synapseBody, truncated: event.synapseTruncated === true }
  switch (event?.type) {
    case 'user/message': return boundedContent(event.data?.content, BODY_LIMITS.textBytes, true)
    case 'assistant/message': return boundedContent(event.data?.message?.content, BODY_LIMITS.textBytes, true)
    case 'todo/write': {
      const todos = event.data?.todos
      if (!Array.isArray(todos)) return { text: '', truncated: false }
      let text = ''
      let count = 0
      while (count < todos.length && count < 2048 && text.length < BODY_LIMITS.textBytes) {
        const todo = todos[count++]
        text += `[${String(todo?.status ?? '').slice(0, 40)}] ${String(todo?.content ?? '').slice(0, BODY_LIMITS.textBytes - text.length)}\n`
      }
      return boundedString(text.trim(), BODY_LIMITS.textBytes, count < todos.length || text.length >= BODY_LIMITS.textBytes)
    }
    case 'turn/end':
      if (event.data?.reason?.kind !== 'error') return { text: '本轮已取消', truncated: false }
      return boundedError(event.data.reason.error ?? '本轮执行失败', BODY_LIMITS.textBytes)
    default: return boundedError(event?.data?.error ?? event?.data?.reason ?? event?.data, BODY_LIMITS.textBytes)
  }
}

/** Only metadata the UI uses is copied; arbitrary/deep payloads never leak. */
function processEntry(entry, record) {
  const result = {
    callId: boundedString(String(entry.callId ?? ''), 512).text,
    name: boundedString(entry.name ?? '', 512).text,
    status: ['pending', 'done', 'failed'].includes(entry.status) ? entry.status : undefined,
  }
  let truncated = record?.truncated === true
  for (const field of ['arguments', 'result', 'error']) {
    const value = record && Object.hasOwn(record, field) ? record[field] : entry[field]
    const capped = field === 'error' ? boundedError(value, BODY_LIMITS.toolFieldBytes) : boundedString(value, BODY_LIMITS.toolFieldBytes)
    result[field] = capped.text || null
    truncated ||= capped.truncated
  }
  if (truncated) result.truncated = true
  return result
}

export function bodySelection(messages) {
  const seqs = new Set(messages.map(message => message.sourceSeq).filter(Number.isSafeInteger))
  const callIds = new Set()
  for (const message of messages) {
    for (const entry of (Array.isArray(message.process) ? message.process : []).slice(0, BODY_LIMITS.processEntries)) callIds.add(String(entry.callId ?? ''))
  }
  return { seqs, callIds }
}

function toolId(event) {
  return String(event.type === 'tool/call' ? event.data?.callId ?? '' : event.data?.message?.source?.callId ?? '')
}

function toolRecord(event) {
  if (event.type === 'tool/call') {
    const value = boundedString(event.data?.arguments, BODY_LIMITS.toolFieldBytes)
    return { arguments: value.text || null, truncated: value.truncated }
  }
  const value = boundedContent(event.data?.message?.content, BODY_LIMITS.toolFieldBytes)
  const error = boundedError(event.data?.error, BODY_LIMITS.toolFieldBytes)
  return { result: value.text || null, error: error.text || null, truncated: value.truncated || error.truncated }
}

/** Compatibility helper; the HTTP caller passes only a selected page. */
export function bodiesFromEvents(thread, events, seqs) {
  const wanted = seqs === null ? null : new Set(seqs)
  const selected = (thread.messages ?? []).filter(message => wanted === null || wanted.has(message.sourceSeq))
  const selection = bodySelection(selected)
  const eventsBySeq = new Map()
  const calls = new Map()
  for (const event of events) {
    if (selection.seqs.has(event?.seq)) eventsBySeq.set(event.seq, event)
    if ((event?.type === 'tool/call' || event?.type === 'tool/result') && selection.callIds.has(toolId(event))) {
      const id = toolId(event)
      const previous = calls.get(id) ?? {}
      const record = event.synapseTool ?? toolRecord(event)
      calls.set(id, { ...previous, ...record, truncated: previous.truncated === true || record.truncated === true })
    }
  }
  const messages = {}
  for (const message of selected) {
    const event = eventsBySeq.get(message.sourceSeq)
    if (event === undefined) continue
    messages[String(message.sourceSeq)] = boundedMessage(message, bodyOf(event), calls)
  }
  return messages
}

function boundedMessage(message, body, calls = new Map()) {
  const process = []
  let bytes = 2
  const original = Array.isArray(message.process) ? message.process : []
  for (const entry of original.slice(0, BODY_LIMITS.processEntries)) {
    const bounded = processEntry(entry, calls.get(String(entry.callId)))
    const size = jsonBytes(bounded) + 1
    if (bytes + size > BODY_LIMITS.processBytes - 1024) break
    bytes += size
    process.push(bounded)
  }
  const omitted = original.length - process.length
  return {
    text: body.text, truncated: body.truncated, process,
    ...(omitted > 0 || process.some(entry => entry.truncated) ? { processTruncated: true, omittedProcess: omitted } : {}),
  }
}

export function previewBody(message, reason) {
  return { ...boundedMessage(message, boundedString(message.text ?? '', BODY_LIMITS.textBytes, message.truncated === true)),
    previewOnly: true, reason }
}

/** Reserve envelope space and count the actual escaped UTF-8 response. */
export function bodyPage(messages, payloads, cursor, total) {
  const response = { messages: {}, cursor, nextCursor: null, total }
  let size = jsonBytes(response) + 1024
  let consumed = 0
  for (const message of messages) {
    const key = String(message.sourceSeq)
    const payload = payloads[key] ?? previewBody(message, 'missing')
    const bytes = jsonBytes(key) + jsonBytes(payload) + 2
    if (size + bytes > BODY_LIMITS.responseBytes) break
    response.messages[key] = payload
    size += bytes
    consumed += 1
  }
  if (cursor + consumed < total) response.nextCursor = cursor + consumed
  return response
}

// DSH appends concatenated zstd frames. Parse frame lengths, since magic bytes
// may also occur inside an uncompressed block. Partial trailing frames are OK.
function* sessionFrames(buffer, limits) {
  if (buffer.length > limits.compressedBytes) throw new LogLimitError('压缩文件')
  let offset = 0
  while (offset + 4 <= buffer.length) {
    const start = offset
    const magic = buffer.readUInt32LE(offset)
    if ((magic >>> 4) === (0x184d2a50 >>> 4)) {
      if (offset + 8 > buffer.length) return
      offset += 8 + buffer.readUInt32LE(offset + 4)
      if (offset > buffer.length) return
      continue
    }
    if (magic !== 0xfd2fb528 || offset + 5 > buffer.length) return
    const descriptor = buffer[offset + 4]
    if (descriptor & 0x18) return // reserved/unused bits
    const single = (descriptor & 0x20) !== 0
    const fcsBytes = [single ? 1 : 0, 2, 4, 8][descriptor >>> 6]
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 3]
    offset += 5
    if (!single) {
      if (offset >= buffer.length) return
      const window = buffer[offset++]
      const base = 2 ** (10 + (window >>> 3))
      if (base + (base / 8) * (window & 7) > limits.decodedBytes) throw new LogLimitError('解压窗口')
    }
    offset += dictionaryBytes
    if (offset + fcsBytes > buffer.length) return
    if (fcsBytes > 0) {
      const size = fcsBytes === 8 ? buffer.readBigUInt64LE(offset) : BigInt(buffer.readUIntLE(offset, fcsBytes) + (fcsBytes === 2 ? 256 : 0))
      if (size > BigInt(limits.frameBytes)) throw new LogLimitError('单帧解压')
    }
    offset += fcsBytes
    let last = false
    while (!last) {
      if (offset + 3 > buffer.length) return
      const header = buffer.readUIntLE(offset, 3)
      offset += 3
      last = (header & 1) !== 0
      const type = (header >>> 1) & 3
      if (type === 3) return
      offset += type === 1 ? 1 : header >>> 3
      if (offset > buffer.length) return
    }
    if (descriptor & 4) offset += 4
    if (offset > buffer.length) return
    yield buffer.subarray(start, offset)
  }
  return offset === buffer.length
}

function decodeOptions(bytes) {
  return { maxOutputLength: bytes, params: { [constants.ZSTD_d_windowLogMax]: 25 } }
}

function decodeError(error) {
  if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw new LogLimitError('解压容量')
  throw error
}

/** Bounded synchronous export for compatibility; production uses async zlib. */
export function decodeSessionLog(buffer, options = {}) {
  if (typeof zstdDecompressSync !== 'function') return null
  const limits = { ...LOG_LIMITS, ...options }
  const parts = []
  let size = 0
  for (const frame of sessionFrames(buffer, limits)) {
    if (size >= limits.decodedBytes) throw new LogLimitError('总解压')
    let decoded
    try { decoded = zstdDecompressSync(frame, decodeOptions(Math.min(limits.frameBytes, limits.decodedBytes - size))) }
    catch (error) { if (error.code === 'ERR_BUFFER_TOO_LARGE') decodeError(error); break }
    size += decoded.length
    parts.push(decoded)
  }
  return parts.length === 0 ? null : Buffer.concat(parts, size).toString('utf8')
}

const decompress = typeof zstdDecompress === 'function' ? promisify(zstdDecompress) : null
const SESSION_LOG_PATTERN = /^session(?:\.[\w-]+)*\.jsonl\.zstd$/

/** Retain only selected, bounded events; account cache size and gate reads. */
export class SessionLogReader {
  constructor(directory, options = {}) {
    this.directory = directory
    this.limits = { ...LOG_LIMITS, ...options }
    this.cache = new Map()
    this.cacheBytes = 0
    this.inflight = new Map()
    this.activeReads = 0
    this.waiters = []
  }

  /**
   * Visit raw events without retaining full bodies. Repairs use a complete,
   * validated snapshot; a partial frame or malformed row never commits it.
   */
  async scan(sessionId, visit) {
    if (!decompress || !this.directory || typeof sessionId !== 'string' || sessionId === '') return null
    if (this.activeReads + this.waiters.length >= this.limits.pendingReads) throw new LogLimitError('并发读取')
    if (this.activeReads >= this.limits.concurrency) await new Promise(resolve => this.waiters.push(resolve))
    else this.activeReads += 1
    try {
      const file = await this.findLog(sessionId)
      if (file === null) return null
      const info = await stat(file)
      if (info.size === 0) return false
      if (info.size > this.limits.compressedBytes) throw new LogLimitError('压缩文件')
      const chunks = []
      let size = 0
      for await (const chunk of createReadStream(file, { end: info.size - 1 })) {
        size += chunk.length
        if (size > this.limits.compressedBytes) throw new LogLimitError('压缩文件')
        chunks.push(chunk)
      }
      const compressed = Buffer.concat(chunks, size)
      chunks.length = 0
      let tail = Buffer.alloc(0)
      let decodedBytes = 0
      const consume = line => {
        if (line.length > this.limits.lineBytes) throw new LogLimitError('单行内容')
        if (line.length === 0) return
        const event = JSON.parse(line.toString('utf8'))
        if (Number.isSafeInteger(event?.seq)) visit(event)
      }
      const frames = sessionFrames(compressed, this.limits)
      let next
      while (!(next = frames.next()).done) {
        const frame = next.value
        if (decodedBytes >= this.limits.decodedBytes) throw new LogLimitError('总解压')
        let decoded
        try { decoded = await decompress(frame, decodeOptions(Math.min(this.limits.frameBytes, this.limits.decodedBytes - decodedBytes))) }
        catch (error) { decodeError(error) }
        decodedBytes += decoded.length
        const data = tail.length ? Buffer.concat([tail, decoded]) : decoded
        let start = 0
        for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
          consume(data.subarray(start, end))
          start = end + 1
        }
        if (data.length - start > this.limits.lineBytes) throw new LogLimitError('单行内容')
        tail = Buffer.from(data.subarray(start))
      }
      if (next.value !== true || decodedBytes === 0) return false
      consume(tail)
      return true
    } finally {
      const next = this.waiters.shift()
      if (next) next()
      else this.activeReads -= 1
    }
  }

  async events(sessionId, selection = null) {
    if (!decompress || typeof this.directory !== 'string' || this.directory === '' || typeof sessionId !== 'string' || sessionId === '') return null
    const selector = selection === null ? '*' : JSON.stringify([[...selection.seqs].sort((a, b) => a - b), [...selection.callIds].sort()])
    const key = JSON.stringify([sessionId, selector])
    if (this.inflight.has(key)) return this.inflight.get(key)
    if (this.inflight.size >= this.limits.pendingReads) throw new LogLimitError('并发读取')
    const pending = this.read(sessionId, selection, key).finally(() => this.inflight.delete(key))
    this.inflight.set(key, pending)
    return pending
  }

  async read(sessionId, selection, key) {
    if (this.activeReads >= this.limits.concurrency) await new Promise(resolve => this.waiters.push(resolve))
    else this.activeReads += 1
    try {
      const file = await this.findLog(sessionId)
      if (file === null) { this.evict(key); return null }
      let info
      try { info = await stat(file) }
      catch (error) {
        if (error.code === 'ENOENT') { this.evict(key); return null }
        throw error
      }
      const cached = this.cache.get(key)
      if (cached?.mtimeMs === info.mtimeMs && cached?.size === info.size) {
        this.cache.delete(key)
        this.cache.set(key, cached)
        return cached.events
      }
      this.evict(key)
      if (info.size > this.limits.compressedBytes) throw new LogLimitError('压缩文件')
      const chunks = []
      let compressedBytes = 0
      // end pins the snapshot even if a live writer appends during this read.
      if (info.size === 0) return null
      for await (const chunk of createReadStream(file, { end: info.size - 1 })) {
        compressedBytes += chunk.length
        if (compressedBytes > this.limits.compressedBytes) throw new LogLimitError('压缩文件')
        chunks.push(chunk)
      }
      const compressed = Buffer.concat(chunks, compressedBytes)
      chunks.length = 0
      const events = []
      let retainedBytes = Buffer.byteLength(key, 'utf8') * 3 + 128
      if (retainedBytes > this.limits.cacheBytes) throw new LogLimitError('所选正文容量')
      let decodedBytes = 0
      let tail = Buffer.alloc(0)
      const consume = line => {
        if (line.length > this.limits.lineBytes) throw new LogLimitError('单行内容')
        if (line.length === 0) return
        let event
        try { event = JSON.parse(line.toString('utf8')) } catch { return }
        if (!Number.isSafeInteger(event?.seq)) return
        const wantedBody = selection === null || selection.seqs.has(event.seq)
        const wantedTool = (event.type === 'tool/call' || event.type === 'tool/result') && (selection === null || selection.callIds.has(toolId(event)))
        if (!wantedBody && !wantedTool) return
        const kept = { seq: event.seq, type: ownString(String(event.type ?? '').slice(0, 256)) }
        if (wantedBody) {
          const body = bodyOf(event)
          kept.synapseBody = body.text
          kept.synapseTruncated = body.truncated
        }
        if (wantedTool) {
          const id = ownString(toolId(event))
          kept.data = event.type === 'tool/call' ? { callId: id } : { message: { source: { callId: id } } }
          kept.synapseTool = toolRecord(event)
        }
        // Conservative allowance for UTF-16 strings and object overhead, not
        // just compressed bytes or an item count.
        retainedBytes += jsonBytes(kept) * 3 + 256
        if (retainedBytes > this.limits.cacheBytes) throw new LogLimitError('所选正文容量')
        events.push(kept)
      }
      let frames = 0
      for (const frame of sessionFrames(compressed, this.limits)) {
        if (decodedBytes >= this.limits.decodedBytes) throw new LogLimitError('总解压')
        let decoded
        try { decoded = await decompress(frame, decodeOptions(Math.min(this.limits.frameBytes, this.limits.decodedBytes - decodedBytes))) }
        catch (error) { if (error.code === 'ERR_BUFFER_TOO_LARGE') decodeError(error); break }
        decodedBytes += decoded.length
        frames += 1
        const data = tail.length ? Buffer.concat([tail, decoded]) : decoded
        let start = 0
        for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
          consume(data.subarray(start, end))
          start = end + 1
        }
        if (data.length - start > this.limits.lineBytes) throw new LogLimitError('单行内容')
        tail = Buffer.from(data.subarray(start))
      }
      if (frames === 0) return null
      consume(tail) // A final valid JSON line need not have a newline.
      while (this.cache.size >= this.limits.cacheEntries || this.cacheBytes + retainedBytes > this.limits.cacheBytes) {
        if (this.cache.size === 0) break
        this.evict(this.cache.keys().next().value)
      }
      if (this.limits.cacheEntries > 0) {
        this.cache.set(key, { events, bytes: retainedBytes, mtimeMs: info.mtimeMs, size: info.size })
        this.cacheBytes += retainedBytes
      }
      return events
    } finally {
      const next = this.waiters.shift()
      if (next) next()
      else this.activeReads -= 1
    }
  }

  evict(key) {
    const entry = this.cache.get(key)
    if (entry) this.cacheBytes -= entry.bytes
    this.cache.delete(key)
  }

  async findLog(sessionId) {
    let workspaces
    try { workspaces = await readdir(this.directory, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue
      const directory = join(this.directory, workspace.name, sessionId)
      let files
      try { files = await readdir(directory) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      const log = files.find(name => SESSION_LOG_PATTERN.test(name))
      if (log !== undefined) return join(directory, log)
    }
    return null
  }
}
