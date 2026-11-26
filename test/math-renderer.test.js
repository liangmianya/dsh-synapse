import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

/**
 * Load the browser math module the way the map iframe does: the bundled KaTeX
 * UMD build first, then `math.js`. Neither needs a DOM, so the real engine (not
 * a stub) is what the scanner and renderer are tested against.
 */
async function loadMath() {
  const [engine, math] = await Promise.all([
    readFile(new URL('../vendor/katex/katex.min.js', import.meta.url), 'utf8'),
    readFile(new URL('../math.js', import.meta.url), 'utf8'),
  ])
  const context = vm.createContext({})
  vm.runInContext(engine, context)
  vm.runInContext(math, context)
  return context.SynapseMath
}

// The scanner runs inside its own vm realm, so rebuild the labels in this realm
// before comparing; deepStrictEqual also checks array prototypes.
const kinds = segments => Array.from(segments, segment => segment.kind === 'math' ? `math:${segment.value}:${segment.display}` : `text:${segment.value}`)

test('splits inline math out of surrounding prose', async () => {
  const SynapseMath = await loadMath()
  assert.deepEqual(kinds(SynapseMath.scanInline('前 $a+b$ 后')), ['text:前 ', 'math:a+b:false', 'text: 后'])
})

test('does not treat prices as math', async () => {
  const SynapseMath = await loadMath()
  assert.deepEqual(kinds(SynapseMath.scanInline('价格 $5 和 $10')), ['text:价格 $5 和 $10'])
})

test('an escaped dollar stays literal and does not open math', async () => {
  const SynapseMath = await loadMath()
  assert.deepEqual(kinds(SynapseMath.scanInline('\\$5 与 $x$')), ['text:$5 与 ', 'math:x:false'])
})

test('math inside a code span is left alone', async () => {
  const SynapseMath = await loadMath()
  assert.deepEqual(kinds(SynapseMath.scanInline('执行 `$x$` 即可')), ['text:执行 `$x$` 即可'])
})

test('double dollars produce display math', async () => {
  const SynapseMath = await loadMath()
  assert.deepEqual(kinds(SynapseMath.scanInline('前 $$E=mc^2$$ 后')), ['text:前 ', 'math:E=mc^2:true', 'text: 后'])
})

test('backslash-paren and backslash-bracket delimiters are supported', async () => {
  const SynapseMath = await loadMath()
  assert.deepEqual(kinds(SynapseMath.scanInline('\\(a\\) 与 \\[b\\]')), ['math:a:false', 'text: 与 ', 'math:b:true'])
})

test('an unterminated inline dollar stays raw until the reply completes', async () => {
  const SynapseMath = await loadMath()
  assert.deepEqual(kinds(SynapseMath.scanInline('正在生成 $a+b')), ['text:正在生成 $a+b'])
})

test('block math needs the whole segment, not just a prefix and suffix', async () => {
  const SynapseMath = await loadMath()
  const display = text => {
    const found = SynapseMath.block(text)
    return found === null ? null : { value: found.value, display: found.display }
  }
  assert.deepEqual(display('$$\n\\sum I_{in}=\\sum I_{out}\n$$'), { value: '\\sum I_{in}=\\sum I_{out}', display: true })
  assert.deepEqual(display('\\[ x^2 \\]'), { value: 'x^2', display: true })
  assert.equal(display('$$a$$ 和 $$b$$'), null)
  assert.equal(display('普通段落'), null)
})

test('renders the sample formula with the bundled KaTeX', async () => {
  const SynapseMath = await loadMath()
  const html = SynapseMath.render('\\sum I_{in}=\\sum I_{out}', false)
  assert.match(html, /class="katex"/)
  assert.match(html, /∑/)
  assert.match(html, /<math/)
})

test('invalid TeX degrades to a KaTeX error node instead of throwing', async () => {
  const SynapseMath = await loadMath()
  const html = SynapseMath.render('\\frac{1}{', false)
  assert.match(html, /katex-error/)
})

test('repeat renders of one expression hit the expression cache', async () => {
  const SynapseMath = await loadMath()
  const first = SynapseMath.render('E=mc^2', false)
  const before = SynapseMath.stats()
  const second = SynapseMath.render('E=mc^2', false)
  const after = SynapseMath.stats()
  assert.equal(second, first)
  assert.equal(after.hits, before.hits + 1)
  assert.ok(after.size >= 1)
})
