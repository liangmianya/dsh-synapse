import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

async function loadRenderer() {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const helpers = await readFile(new URL('../browser-cache.js', import.meta.url), 'utf8')
  const escape = source.slice(source.indexOf('const escapeHtml'), source.indexOf('const formatTime'))
  const renderer = source.slice(source.indexOf('function inlineMarkdown'), source.indexOf('function overlapsCard'))
  const context = { globalThis: {} }
  vm.createContext(context)
  vm.runInContext(`${helpers}\n${escape}\n${renderer};globalThis.renderMarkdown = renderMarkdown`, context)
  return context.globalThis.renderMarkdown
}

test('renders PowerShell marker-only diagnostic lines without stalling', async () => {
  const renderMarkdown = await loadRenderer()
  const input = 'cmd : Access is denied.\nAt line:1 char:1\n+ \n+ ~~~~~\n    + CategoryInfo : PermissionDenied'
  const result = renderMarkdown(input)

  assert.match(result, /cmd : Access is denied/)
  assert.match(result, /CategoryInfo/)
})
