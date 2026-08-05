import assert from 'node:assert/strict'
import test from 'node:test'
import {abortable, isAbortReason, RuntimeLifecycle} from '../dist/runtime-lifecycle.js'

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return {promise, resolve}
}

test('RuntimeLifecycle aborts once and exposes the original reason', () => {
  const runtime = new RuntimeLifecycle()
  const reason = new Error('shutdown')

  runtime.abort(reason)
  runtime.abort(new Error('ignored'))

  assert.equal(runtime.signal.aborted, true)
  assert.equal(runtime.signal.reason, reason)
  assert.equal(isAbortReason(reason, runtime.signal), true)
})

test('abortable rejects promptly without waiting for the underlying operation', async () => {
  const runtime = new RuntimeLifecycle()
  const operation = deferred()
  const pending = abortable(operation.promise, runtime.signal)
  const reason = new Error('shutdown')

  runtime.abort(reason)
  await assert.rejects(pending, (error) => error === reason)
  operation.resolve('late result')
})

test('RuntimeLifecycle waits for all tracked background tasks to settle', async () => {
  const runtime = new RuntimeLifecycle()
  const first = deferred()
  const second = deferred()
  runtime.track(first.promise)
  runtime.track(second.promise)

  let settled = false
  const waiting = runtime.waitForBackgroundTasks().then(() => {
    settled = true
  })
  first.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)

  second.resolve()
  await waiting
  assert.equal(settled, true)
})
