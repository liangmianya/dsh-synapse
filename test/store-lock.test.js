import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceStore } from '../index.js'

test('a second writer does not overwrite or release the first lock', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-lock-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dataFile = join(dir, 'workspaces.json')
  const first = new WorkspaceStore(dataFile)
  await first.ready
  assert.equal(await first.acquireLock(), true)

  const second = new WorkspaceStore(dataFile)
  await second.ready
  await assert.rejects(second.save(), error => {
    assert.equal(error.code, 'SYNAPSE_STORE_LOCKED')
    return true
  })
  assert.match(await readFile(`${dataFile}.lock`, 'utf8'), /^\d+:[0-9a-f-]+\n$/)

  // The losing writer must not delete the winner's lock.
  await second.releaseLock()
  assert.match(await readFile(`${dataFile}.lock`, 'utf8'), /^\d+:[0-9a-f-]+\n$/)

  await first.releaseLock()
  await second.save()
  assert.equal(second.lockOwner, null)
})

test('takes over a lock left by a dead process', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-lock-stale-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dataFile = join(dir, 'workspaces.json')
  const store = new WorkspaceStore(dataFile)
  await store.ready
  await writeFile(`${dataFile}.lock`, '999999:stale\n', 'utf8')

  assert.equal(await store.acquireLock(), true)
  assert.match(await readFile(`${dataFile}.lock`, 'utf8'), new RegExp(`^${process.pid}:`))
  await store.releaseLock()
})
