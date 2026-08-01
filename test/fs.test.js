import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {pathExists, writeFileWithParents} from '../dist/fs.js'

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
