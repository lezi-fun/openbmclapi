import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {pathExists, writeFileAtomic, writeFileWithParents} from '../dist/fs.js'

test('native file helpers create parents and report path existence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbmclapi-fs-'))
  const path = join(dir, 'nested', 'empty-file')

  try {
    assert.equal(await pathExists(path), false)
    await writeFileWithParents(path, new Uint8Array())
    assert.equal(await pathExists(path), true)
    assert.deepEqual(await readFile(path), Buffer.alloc(0))
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test('atomic file writes replace complete files without leaving temporary files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbmclapi-fs-'))
  const path = join(dir, 'nested', 'cache-file')

  try {
    await writeFileAtomic(path, Buffer.from('first'))
    await writeFileAtomic(path, Buffer.from('second'))

    assert.equal((await readFile(path)).toString(), 'second')
    assert.deepEqual(await readdir(join(dir, 'nested')), ['cache-file'])
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test('atomic file writes clean up temporary files when publishing fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbmclapi-fs-'))
  const target = join(dir, 'existing-directory')

  try {
    await mkdir(target)
    await assert.rejects(writeFileAtomic(target, Buffer.from('content')))
    assert.deepEqual(await readdir(dir), ['existing-directory'])
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})
