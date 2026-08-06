import assert from 'node:assert/strict'
import test from 'node:test'
import {FileListScheduler} from '../dist/file-list-scheduler.js'

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return {promise, resolve}
}

function fileList(mtime) {
  return {files: [{path: '/file.jar', hash: 'hash', size: 1, mtime}]}
}

test('FileListScheduler refreshes only after its timer and advances non-empty deltas', async () => {
  const previous = fileList(1)
  const incremental = fileList(2)
  const callbacks = []
  const delays = []
  const requests = []
  const syncs = []
  const tracked = []
  const runtime = {
    signal: new AbortController().signal,
    track(task) {
      tracked.push(task)
      return task
    },
  }
  const scheduler = new FileListScheduler(
    {
      async getFileList(lastModified) {
        requests.push(lastModified)
        return incremental
      },
      async getConfiguration() {
        return {sync: {source: 'controller', concurrency: 1}}
      },
      async syncFiles(files, syncConfig) {
        syncs.push({files, syncConfig})
      },
    },
    runtime,
    {
      intervalMs: 123,
      timerFactory(callback, milliseconds) {
        callbacks.push(callback)
        delays.push(milliseconds)
        return {unref() {}}
      },
    },
  )

  scheduler.start(previous)
  assert.deepEqual(delays, [123])
  assert.equal(requests.length, 0)

  callbacks.shift()()
  await tracked[0]
  assert.deepEqual(requests, [1])
  assert.equal(syncs.length, 1)
  assert.deepEqual(syncs[0].files, incremental)
  assert.deepEqual(delays, [123, 123])

  callbacks.shift()()
  await tracked[1]
  assert.deepEqual(requests, [1, 2])
  assert.deepEqual(delays, [123, 123, 123])
  scheduler.stop()
})

test('FileListScheduler stop prevents an in-flight refresh from rescheduling', async () => {
  const pending = deferred()
  const callbacks = []
  let cleared = 0
  const tracked = []
  const scheduler = new FileListScheduler(
    {
      async getFileList() {
        await pending.promise
        return {files: []}
      },
      async getConfiguration() {
        throw new Error('configuration must not be requested for an empty delta')
      },
      async syncFiles() {
        throw new Error('sync must not be requested for an empty delta')
      },
    },
    {
      signal: new AbortController().signal,
      track(task) {
        tracked.push(task)
        return task
      },
    },
    {
      timerFactory(callback) {
        callbacks.push(callback)
        return {unref() {}}
      },
      clearTimer() {
        cleared++
      },
    },
  )

  scheduler.start(fileList(1))
  callbacks.shift()()
  scheduler.stop()
  pending.resolve()
  await tracked[0]
  assert.equal(cleared, 0)
  assert.equal(callbacks.length, 0)
})

test('FileListScheduler clears a pending timer and ignores its stale callback', () => {
  const callbacks = []
  const tracked = []
  let cleared = 0
  const scheduler = new FileListScheduler(
    {
      async getFileList() {
        throw new Error('stale callbacks must not refresh')
      },
      async getConfiguration() {
        throw new Error('stale callbacks must not request configuration')
      },
      async syncFiles() {
        throw new Error('stale callbacks must not sync')
      },
    },
    {
      signal: new AbortController().signal,
      track(task) {
        tracked.push(task)
        return task
      },
    },
    {
      timerFactory(callback) {
        callbacks.push(callback)
        return {unref() {}}
      },
      clearTimer() {
        cleared++
      },
    },
  )

  scheduler.start(fileList(1))
  scheduler.stop()
  callbacks.shift()()
  assert.equal(cleared, 1)
  assert.equal(tracked.length, 0)
})
