import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import test from 'node:test'
import {RequestError} from 'got'
import {FileSynchronizer} from '../dist/file-synchronizer.js'

function file(path, content) {
  return {
    path,
    hash: createHash('sha1').update(content).digest('hex'),
    size: content.length,
    mtime: 1,
  }
}

function progressFactory(state) {
  return (files) => {
    state.files = files
    return {
      createFile(current) {
        const bar = {
          file: current,
          updates: [],
          stopped: false,
          stop() {
            this.stopped = true
          },
          update(value) {
            this.updates.push(value)
          },
        }
        state.bars.push(bar)
        return bar
      },
      completeFile(bar) {
        bar.stop()
        state.completed.push(bar.file.path)
      },
      stop() {
        state.stopped = true
      },
    }
  }
}

test('FileSynchronizer preserves missing-file filtering, concurrency, integrity checks, and progress', async () => {
  const contents = new Map([
    ['/one.jar', Buffer.from('one')],
    ['/two.jar', Buffer.from('two')],
    ['/three.jar', Buffer.from('three')],
  ])
  const files = [...contents].map(([path, content]) => file(path, content))
  const writes = []
  const progress = {bars: [], completed: [], stopped: false}
  let active = 0
  let maxActive = 0
  const controller = {
    async downloadFile(path, onProgress) {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setImmediate(resolve))
      const body = contents.get(path)
      onProgress(body.length)
      active--
      return {body, request: {}}
    },
    async reportDownloadError() {},
  }
  const storage = {
    async check() {
      return true
    },
    async getMissingFiles(input, signal) {
      assert.equal(signal.aborted, false)
      return input
    },
    async writeFile(path, body, fileInfo) {
      writes.push({path, body: body.toString(), fileInfo})
    },
  }
  const synchronizer = new FileSynchronizer(controller, storage, new AbortController(), {
    progressFactory: progressFactory(progress),
  })

  await synchronizer.sync({files}, {source: 'controller', concurrency: 2})

  assert.equal(maxActive, 2)
  assert.equal(writes.length, 3)
  assert.deepEqual(writes.map((write) => write.body).sort(), ['one', 'three', 'two'])
  assert.deepEqual(progress.files, files)
  assert.deepEqual(progress.completed.sort(), files.map((entry) => entry.path).sort())
  assert.equal(
    progress.bars.every((bar) => bar.stopped),
    true,
  )
  assert.equal(
    progress.bars.every((bar) => bar.updates[0] === 0 && bar.updates.at(-1) === bar.file.size),
    true,
  )
  assert.equal(progress.stopped, true)
})

test('FileSynchronizer uses p-retry v8 error contexts and reports redirect failures', async () => {
  const content = Buffer.from('content')
  const current = file('/failed.jar', content)
  const redirectUrl = new URL('https://cdn.example/failed.jar')
  const reports = []
  const progress = {bars: [], completed: [], stopped: false}
  let retryOptions
  const requestError = new RequestError('download failed', new Error('download failed'), {})
  requestError.response = {redirectUrls: [redirectUrl]}
  const synchronizer = new FileSynchronizer(
    {
      async downloadFile() {
        throw requestError
      },
      async reportDownloadError(...args) {
        reports.push(args)
      },
    },
    {
      async check() {
        return true
      },
      async getMissingFiles() {
        return [current]
      },
      async writeFile() {
        throw new Error('failed downloads must not be stored')
      },
    },
    new AbortController(),
    {
      progressFactory: progressFactory(progress),
      async retry(operation, options) {
        retryOptions = options
        try {
          return await operation()
        } catch (error) {
          await options.onFailedAttempt({
            error,
            attemptNumber: 1,
            retriesLeft: options.retries,
            retriesConsumed: 1,
            retryDelay: 0,
          })
          throw error
        }
      },
    },
  )

  await assert.rejects(synchronizer.sync({files: [current]}, {source: 'controller', concurrency: 1}), /同步失败/)
  assert.equal(retryOptions.retries, 10)
  assert.equal(retryOptions.unref, true)
  assert.deepEqual(reports, [[current.path, [redirectUrl], 'download failed']])
  assert.deepEqual(progress.completed, [current.path])
  assert.equal(progress.stopped, true)
})

test('FileSynchronizer never stores content that fails its digest check', async () => {
  const current = file('/corrupt.jar', Buffer.from('expected'))
  const progress = {bars: [], completed: [], stopped: false}
  let writeCalled = false
  let retryError
  const synchronizer = new FileSynchronizer(
    {
      async downloadFile() {
        return {body: Buffer.from('corrupt'), request: {}}
      },
      async reportDownloadError() {},
    },
    {
      async check() {
        return true
      },
      async getMissingFiles() {
        return [current]
      },
      async writeFile() {
        writeCalled = true
      },
    },
    new AbortController(),
    {
      progressFactory: progressFactory(progress),
      async retry(operation, options) {
        try {
          return await operation()
        } catch (error) {
          retryError = error
          await options.onFailedAttempt({
            error,
            attemptNumber: 1,
            retriesLeft: options.retries,
            retriesConsumed: 1,
            retryDelay: 0,
          })
          throw error
        }
      },
    },
  )

  await assert.rejects(synchronizer.sync({files: [current]}, {source: 'controller', concurrency: 1}), /同步失败/)
  assert.equal(retryError instanceof RequestError, true)
  assert.equal(writeCalled, false)
})

test('FileSynchronizer rejects unavailable storage before requesting missing files', async () => {
  let missingFilesRequested = false
  const synchronizer = new FileSynchronizer(
    {
      async downloadFile() {
        throw new Error('download must not start')
      },
      async reportDownloadError() {},
    },
    {
      async check() {
        return false
      },
      async getMissingFiles() {
        missingFilesRequested = true
        return []
      },
    },
    new AbortController(),
  )

  await assert.rejects(synchronizer.sync({files: []}, {source: 'controller', concurrency: 1}), /存储异常/)
  assert.equal(missingFilesRequested, false)
})
