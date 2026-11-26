import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

/**
 * Mount the real renderer the way the map iframe does: the bundled KaTeX build,
 * `math.js`, the cache helpers, then the app.js source slice that owns Markdown
 * and math. No DOM is needed, and no part of the renderer is stubbed.
 */
let rendererPromise
function loadRenderer() {
  rendererPromise ??= (async () => {
    const [source, helpers, engine, math] = await Promise.all([
      readFile(new URL('../app.js', import.meta.url), 'utf8'),
      readFile(new URL('../browser-cache.js', import.meta.url), 'utf8'),
      readFile(new URL('../vendor/katex/katex.min.js', import.meta.url), 'utf8'),
      readFile(new URL('../math.js', import.meta.url), 'utf8'),
    ])
    const escape = source.slice(source.indexOf('const escapeHtml'), source.indexOf('const formatTime'))
    const renderer = source.slice(source.indexOf('function mathRenderer'), source.indexOf('function overlapsCard'))
    const context = vm.createContext({})
    vm.runInContext(engine, context)
    vm.runInContext(math, context)
    vm.runInContext(`${helpers}\n${escape}\n${renderer};globalThis.renderMarkdown = renderMarkdown`, context)
    return context.renderMarkdown
  })()
  return rendererPromise
}

test('renders PowerShell marker-only diagnostic lines without stalling', async () => {
  const renderMarkdown = await loadRenderer()
  const input = 'cmd : Access is denied.\nAt line:1 char:1\n+ \n+ ~~~~~\n    + CategoryInfo : PermissionDenied'
  const result = renderMarkdown(input)

  assert.match(result, /cmd : Access is denied/)
  assert.match(result, /CategoryInfo/)
})

test('renders inline math inside a paragraph', async () => {
  const renderMarkdown = await loadRenderer()
  const result = renderMarkdown('基尔霍夫电流定律：$\\sum I_{in}=\\sum I_{out}$ 成立。')

  assert.match(result, /class="katex"/)
  assert.match(result, /∑/)
  assert.match(result, /成立/)
  // KaTeX keeps the TeX source in its MathML annotation; what must disappear
  // is the dollar-delimited text the reader used to see.
  assert.ok(!result.includes('$\\sum'))
})

test('renders math inside list items, headings and table cells', async () => {
  const renderMarkdown = await loadRenderer()
  const list = renderMarkdown('- $x^2$')
  const heading = renderMarkdown('## $\\alpha$ 系数')
  const table = renderMarkdown('| 符号 | 含义 |\n| --- | --- |\n| $\\pi$ | 圆周率 |')

  assert.match(list, /<li><span class="katex">/)
  assert.match(heading, /<h2><span class="katex">.*系数<\/h2>/)
  assert.match(table, /<td><span class="katex">/)
})

test('renders a display formula that owns its paragraph', async () => {
  const renderMarkdown = await loadRenderer()
  const result = renderMarkdown('$$\n\\sum I_{in}=\\sum I_{out}\n$$')

  assert.match(result, /<div class="math-display">/)
  assert.match(result, /katex-display/)
  assert.ok(!result.includes('<p>'))
})

test('renders a math fence instead of a code block', async () => {
  const renderMarkdown = await loadRenderer()
  const result = renderMarkdown('```math\nE=mc^2\n```')

  assert.match(result, /<div class="math-display">/)
  assert.match(result, /katex-display/)
  assert.ok(!result.includes('<pre>'))
})

test('leaves dollars inside fenced and inline code alone', async () => {
  const renderMarkdown = await loadRenderer()
  const fence = renderMarkdown('```sh\necho $5 and $10\n```')
  const inline = renderMarkdown('执行 `$x$` 即可')

  assert.match(fence, /<pre><code>echo \$5 and \$10<\/code><\/pre>/)
  assert.ok(!fence.includes('class="katex"'))
  assert.match(inline, /<code>\$x\$<\/code>/)
  assert.ok(!inline.includes('class="katex"'))
})

test('keeps an unterminated formula as written', async () => {
  const renderMarkdown = await loadRenderer()
  const result = renderMarkdown('公式还没写完 $a+b')

  assert.match(result, /\$a\+b/)
  assert.ok(!result.includes('class="katex"'))
})

test('a malformed expression does not take the rest of the message with it', async () => {
  const renderMarkdown = await loadRenderer()
  const result = renderMarkdown('前 $\\frac{1}{$ 后')

  assert.match(result, /前 /)
  assert.match(result, /后/)
})
