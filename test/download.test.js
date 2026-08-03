import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import test from 'node:test'
import {FileIntegrityError, storeVerifiedDownload} from '../dist/download.js'
import {hashToFilename} from '../dist/util.js'

test('verified downloads write content and metadata to storage', async () => {
  const body = Buffer.from('verified cache content')
  const hash = createHash('sha1').update(body).digest('hex')
  const writes = []
  const storage = {
    async writeFile(path, content, fileInfo) {
      writes.push({path, content, fileInfo})
    },
  }

  await storeVerifiedDownload(storage, hash, body, 1234)

  assert.deepEqual(writes, [
    {
      path: hashToFilename(hash),
      content: body,
      fileInfo: {
        path: `/download/${hash}`,
        hash,
        size: body.length,
        mtime: 1234,
      },
    },
  ])
})

test('corrupt downloads never reach storage', async () => {
  const hash = createHash('md5').update('expected content').digest('hex')
  let writeCalled = false
  const storage = {
    async writeFile() {
      writeCalled = true
    },
  }

  await assert.rejects(
    storeVerifiedDownload(storage, hash, Buffer.from('corrupt content')),
    (error) => error instanceof FileIntegrityError && error.message.includes(hash),
  )
  assert.equal(writeCalled, false)
})
