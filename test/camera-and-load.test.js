// Two regressions found by driving the real map with trusted input (CDP):
//
//   1. Switching conversation changed the state but never moved the camera, so
//      the newly active cards sat thousands of pixels off screen and the map
//      looked frozen — a click that worked read as a dead button.
//   2. `openDshWorkspace` handed out a ticket (`++state.workspaceLoad`); the 1s
//      projection poll took a newer ticket while the user's load was awaiting,
//      so the user's load returned before rendering and the sidebar kept the
//      previous workspace's sessions.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')

const slice = (from, to) => {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + 1)
  assert.ok(start > 0, `missing marker: ${from}`)
  assert.ok(end > start, `missing end marker: ${to}`)
  return source.slice(start, end)
}

test('switching conversation brings that conversation into view', () => {
  const branch = slice("button.dataset.action === 'select-thread'", "button.dataset.action === 'show-thread'")
  assert.match(branch, /render\(\)/)
  assert.match(branch, /requestAnimationFrame\(\(\) => \{ if \(state\.mode === 'canvas'\) focusActiveCard\(\) \}\)/)
})

test('a user workspace switch is not cancelled by the projection poll', () => {
  assert.match(source, /workspaceLoadOwner/)
  assert.match(source, /if \(!userInitiated && \(state\.workspaceLoadOwner === 'user' \|\| state\.workspaceLoadBusy\)\) return false/)
  // The user-initiated call site must actually ask for that protection.
  const changeHandler = slice('[data-action="select-workspace"]', 'const choice = workspaceChoices()')
  assert.ok(changeHandler.length > 0)
  assert.match(source, /openDshWorkspace\(choice\.id, \{ userInitiated: true \}\)/)
  // ...and the ticket must be released even when the load throws.
  assert.match(source, /finally \{[\s\S]{0,160}state\.workspaceLoadOwner = null/)
})

test('the poll refreshes quietly instead of re-running the whole load', () => {
  // 16 loads / 12 cancellations in 19s came from every poll tick opening a new
  // workspace load. The poll now re-fetches the current payload and renders only
  // when its fingerprint changed, and loads themselves are single-flight.
  assert.match(source, /async function refreshCurrentWorkspace\(\)/)
  assert.match(source, /if \(state\.workspaceFingerprint === fingerprint\) return false/)
  assert.match(source, /state\.workspaceLoadBusy = false/)
  const projection = slice('async function refreshProjection()', 'function openNewSession')
  assert.match(projection, /return refreshCurrentWorkspace\(\)/)
})
