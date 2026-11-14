import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function loadMessagesFromEvents() {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const start = source.indexOf('function messagesFromEvents')
  const end = source.indexOf('async function loadThreadHistory')
  const context = { globalThis: {} }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)};globalThis.messagesFromEvents = messagesFromEvents`, context)
  return context.globalThis.messagesFromEvents
}

test('does not turn DSH runtime context into a question card', async () => {
  const messagesFromEvents = await loadMessagesFromEvents()
  const messages = messagesFromEvents([
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\nPolicy details.' }] } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '你是谁' }] } },
  ])

  assert.deepEqual(messages.map(message => message.text), ['你是谁'])
})

test('keeps only the typed turn and imported rows, whatever kind the harness injects', async () => {
  const messagesFromEvents = await loadMessagesFromEvents()
  const messages = messagesFromEvents([
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '真实提问' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '<system-reminder>\nThe following workspace instructions may be relevant' }], source: { kind: 'agent-instructions' } } },
    { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: '<system-reminder>\nThe following information describes your current session' }], source: { kind: 'runtime-context' } } },
    { type: 'user/message', seq: 4, time: 4, data: { content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-11-14T19:01:24+08:00' }], source: { kind: 'time-context' } } },
    { type: 'user/message', seq: 5, time: 5, data: { content: [{ type: 'text', text: '导入的旧会话提问' }] } },
  ])

  assert.deepEqual(messages.map(message => message.text), ['真实提问', '导入的旧会话提问'])
})
