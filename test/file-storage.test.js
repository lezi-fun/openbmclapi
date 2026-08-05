import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {FileStorage} from '../dist/storage/file.storage.js'
import {hashToFilename} from '../dist/util.js'

test('FileStorage reports missing and size-mismatched files in input order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbmclapi-storage-'))
  const storage = new FileStorage(dir)
  const correct = {path: '/correct', hash: 'a'.repeat(32), size: 4, mtime: 1}
  const mismatched = {path: '/mismatched', hash: 'b'.repeat(32), size: 5, mtime: 2}
  const absent = {path: '/absent', hash: 'c'.repeat(32), size: 6, mtime: 3}

  try {
    await storage.writeFile(hashToFilename(correct.hash), Buffer.alloc(correct.size))
    await storage.writeFile(hashToFilename(mismatched.hash), Buffer.alloc(1))

    assert.deepEqual(await storage.getMissingFiles([correct, mismatched, absent]), [mismatched, absent])
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test('FileStorage uses normalized range accounting and attachment headers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbmclapi-storage-'))
  const storage = new FileStorage(dir)
  const hash = 'd'.repeat(32)
  const hashPath = hashToFilename(hash)
  const headers = new Map()
  let servedPath
  const res = {
    set(name, value) {
      headers.set(name.toLowerCase(), value)
      return this
    },
    sendFile(path, _options, callback) {
      servedPath = path
      callback()
    },
  }

  try {
    await storage.writeFile(hashPath, Buffer.alloc(100))
    const result = await storage.serve(
      {
        hash,
        hashPath,
        method: 'GET',
        range: 'bytes=10-19',
        attachmentName: 'client.jar',
      },
      res,
    )

    assert.equal(servedPath, join(dir, hashPath))
    assert.deepEqual(result, {bytes: 10, hits: 1})
    assert.match(headers.get('content-disposition'), /^attachment;/)
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test('FileStorage aborts an active response with the runtime reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbmclapi-storage-'))
  const storage = new FileStorage(dir)
  const hash = 'e'.repeat(32)
  const hashPath = hashToFilename(hash)
  const controller = new AbortController()
  const reason = new Error('shutdown')
  let sendCallback
  let destroyedWith
  let resolveSendStarted
  const sendStarted = new Promise((resolve) => {
    resolveSendStarted = resolve
  })
  const res = {
    set() {
      return this
    },
    sendFile(_path, _options, callback) {
      sendCallback = callback
      resolveSendStarted()
    },
    destroy(error) {
      destroyedWith = error
      sendCallback?.(new Error('Request aborted'))
    },
  }

  try {
    await storage.writeFile(hashPath, Buffer.alloc(100))
    const serving = storage.serve({hash, hashPath, method: 'GET', signal: controller.signal}, res)
    await sendStarted
    controller.abort(reason)

    await assert.rejects(serving, (error) => error === reason)
    assert.equal(destroyedWith, reason)
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test('FileStorage cancellation prevents garbage collection from deleting files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbmclapi-storage-'))
  const storage = new FileStorage(dir)
  const hash = 'f'.repeat(32)
  const hashPath = hashToFilename(hash)
  const controller = new AbortController()
  const reason = new Error('shutdown')

  try {
    await storage.writeFile(hashPath, Buffer.alloc(10))
    controller.abort(reason)
    await assert.rejects(storage.gc([], controller.signal), (error) => error === reason)
    assert.equal(await storage.exists(hashPath), true)
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})
