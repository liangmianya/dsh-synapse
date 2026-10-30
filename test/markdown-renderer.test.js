import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

async function loadRenderer() {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const start = source.indexOf('const escapeHtml')
  const end = source.indexOf('function canvasConnectors')
  const context = { globalThis: {} }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)};globalThis.renderMarkdown = renderMarkdown`, context)
  return context.globalThis.renderMarkdown
}

test('renders PowerShell marker-only diagnostic lines without stalling', async () => {
  const renderMarkdown = await loadRenderer()
  const input = 'cmd : Access is denied.\nAt line:1 char:1\n+ \n+ ~~~~~\n    + CategoryInfo : PermissionDenied'
  const result = renderMarkdown(input)

  assert.match(result, /cmd : Access is denied/)
  assert.match(result, /CategoryInfo/)
})

test('colours a fenced block from its info string, and keeps the code escaped', async () => {
  const renderMarkdown = await loadRenderer()

  // The info string survives as `data-lang`, and a known language is tokenised.
  assert.match(
    renderMarkdown('```ts\nconst a = 1 // note\n```'),
    /<pre data-lang="ts"><code><span class="tok-key">const<\/span> a = <span class="tok-num">1<\/span> <span class="tok-com">\/\/ note<\/span>[\s\S]*<\/code><\/pre>/,
  )
  // Raw HTML in a fence stays text: colouring must not open an injection path.
  const html = renderMarkdown('```html\n<script>x</script>\n```')
  assert.match(html, /&lt;<span class="tok-tag">script<\/span>&gt;/)
  assert.doesNotMatch(html, /<script>/)
  // A tag nobody has heard of still gets the C-like default rather than going flat.
  assert.match(renderMarkdown('```nope\nif (a) return "b"\n```'), /<span class="tok-key">if<\/span>/)
  // Output-shaped fences stay plain: a transcript is not source.
  assert.equal(renderMarkdown('```text\nsay "hi"\n```').includes('tok-'), false)
})
