/**
 * Synapse math rendering.
 *
 * The map iframe loads the bundled KaTeX build first and then this file, so
 * `globalThis.katex` is the engine and this module stays a pure string API: no
 * DOM, no application state, no network. It answers two questions for the
 * Markdown renderer in app.js:
 *
 *   scanInline(text)  which runs of this text are math, and which are prose?
 *   render(tex, display) what HTML does KaTeX produce for this expression?
 *
 * Delimiters follow DSH's own conversation (`$...$`, `$$...$$`) and also accept
 * `\(...\)`, `\[...\]`, because people paste formulas from editors that emit
 * them. Code spans are never treated as math, and a dollar escape stays
 * literal. An expression KaTeX cannot parse renders as its red `.katex-error`
 * node instead of throwing, so one broken formula cannot blank a whole reply.
 */
(function (global) {
  'use strict'

  // KaTeX output is deterministic for a given source, so a small expression
  // cache keeps scrolling and streaming from re-typesetting the same formulas.
  const CACHE_LIMIT = 256
  const cache = new Map()
  let hits = 0
  let misses = 0

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    })[character])
  }

  function engine() {
    const katex = global.katex
    return katex !== null && typeof katex === 'object' && typeof katex.renderToString === 'function' ? katex : null
  }

  /** Raw TeX is shown as a code span when no engine is available. */
  function fallback(tex) {
    return `<code class="math-source">${escapeHtml(tex)}</code>`
  }

  function render(tex, display) {
    const source = String(tex)
    const key = `${display === true ? 'D' : 'I'}\u0000${source}`
    const cached = cache.get(key)
    if (cached !== undefined) {
      hits++
      return cached
    }
    misses++
    const katex = engine()
    let html
    if (katex === null) {
      // Do not cache: the script order could still deliver the engine later.
      return fallback(source)
    }
    try {
      html = katex.renderToString(source, {
        displayMode: display === true,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
        output: 'htmlAndMathml',
      })
    } catch {
      html = fallback(source)
    }
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
    cache.set(key, html)
    return html
  }

  /** The closing run of backticks, so math inside inline code is skipped. */
  function codeSpanEnd(text, start) {
    let run = 1
    while (text[start + run] === '`') run++
    const fence = '`'.repeat(run)
    const close = text.indexOf(fence, start + run)
    return close === -1 ? -1 : close + run
  }

  /**
   * First unescaped `$` that can close an inline formula. A closer immediately
   * after whitespace is not a closer, which is what keeps "$5 and $10" prose.
   */
  function inlineDollarEnd(text, start) {
    for (let index = start; index < text.length; index++) {
      const character = text[index]
      if (character === '\n') return -1
      if (character === '\\') { index++; continue }
      if (character !== '$') continue
      if (index === start) return -1
      if (/\s/.test(text[index - 1])) return -1
      return index
    }
    return -1
  }

  function unescapedIndex(text, from, needle) {
    for (let index = text.indexOf(needle, from); index !== -1; index = text.indexOf(needle, index + needle.length)) {
      let backslashes = 0
      for (let cursor = index - 1; cursor >= from && text[cursor] === '\\'; cursor--) backslashes++
      if (backslashes % 2 === 0) return index
    }
    return -1
  }

  /** `$$...$$`, allowed across lines; a closer is the next unescaped pair. */
  function displayDollarEnd(text, start) {
    return unescapedIndex(text, start, '$$')
  }

  function scanInline(value) {
    const text = String(value)
    const segments = []
    let buffer = ''
    const flush = () => {
      if (buffer === '') return
      segments.push({ kind: 'text', value: buffer })
      buffer = ''
    }
    const pushMath = (source, display, end) => {
      flush()
      segments.push({ kind: 'math', value: source, display })
      return end
    }

    for (let index = 0; index < text.length;) {
      const character = text[index]
      if (character === '`') {
        const end = codeSpanEnd(text, index)
        if (end !== -1) {
          buffer += text.slice(index, end)
          index = end
          continue
        }
      }
      if (character === '\\') {
        const next = text[index + 1]
        if (next === '$') {
          buffer += '$'
          index += 2
          continue
        }
        if (next === '(') {
          const close = unescapedIndex(text, index + 2, '\\)')
          if (close !== -1 && !text.slice(index + 2, close).includes('\n')) {
            index = pushMath(text.slice(index + 2, close), false, close + 2)
            continue
          }
        }
        if (next === '[') {
          const close = unescapedIndex(text, index + 2, '\\]')
          if (close !== -1) {
            index = pushMath(text.slice(index + 2, close).trim(), true, close + 2)
            continue
          }
        }
        // Any other escape belongs to the Markdown/emphasis pass.
        buffer += character
        index++
        continue
      }
      if (character === '$') {
        if (text[index + 1] === '$') {
          const close = displayDollarEnd(text, index + 2)
          if (close !== -1 && text.slice(index + 2, close).trim() !== '') {
            index = pushMath(text.slice(index + 2, close).trim(), true, close + 2)
            continue
          }
          buffer += '$$'
          index += 2
          continue
        }
        const opener = text[index + 1]
        if (opener !== undefined && !/\s/.test(opener) && opener !== '$') {
          const close = inlineDollarEnd(text, index + 1)
          if (close !== -1) {
            index = pushMath(text.slice(index + 1, close), false, close + 1)
            continue
          }
        }
      }
      buffer += character
      index++
    }
    flush()
    return segments
  }

  /**
   * A whole segment that is one display formula. The inner text must not hold
   * another delimiter pair, so "$a$ text $b$" is not mistaken for a block.
   */
  function block(value) {
    const trimmed = String(value).trim()
    if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4) {
      const inner = trimmed.slice(2, -2)
      if (!inner.includes('$$') && inner.trim() !== '') return { value: inner.trim(), display: true }
    }
    if (trimmed.startsWith('\\[') && trimmed.endsWith('\\]') && trimmed.length > 4) {
      const inner = trimmed.slice(2, -2)
      if (!inner.includes('\\]') && inner.trim() !== '') return { value: inner.trim(), display: true }
    }
    return null
  }

  function stats() {
    return { size: cache.size, hits, misses }
  }

  global.SynapseMath = { scanInline, block, render, stats }
})(typeof globalThis === 'undefined' ? this : globalThis)
