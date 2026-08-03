import assert from 'node:assert/strict'
import test from 'node:test'
import {ClusterLifecycle} from '../dist/cluster-lifecycle.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return {promise, resolve, reject}
}

async function flushTasks() {
  await new Promise((resolve) => setImmediate(resolve))
}

test('concurrent enable requests register the node once', async () => {
  const registration = deferred()
  let enableCalls = 0
  const lifecycle = new ClusterLifecycle(
    async () => {
      enableCalls++
      await registration.promise
    },
    async () => {},
  )

  const first = lifecycle.enable()
  const second = lifecycle.enable()
  await flushTasks()

  assert.equal(enableCalls, 1)
  assert.equal(lifecycle.state, 'enabling')
  registration.resolve()
  await Promise.all([first, second])
  assert.equal(lifecycle.state, 'enabled')
  assert.equal(lifecycle.isEnabled, true)
  assert.equal(lifecycle.wantEnable, true)
})

test('disable requested during registration runs after registration', async () => {
  const registration = deferred()
  const transitions = []
  const lifecycle = new ClusterLifecycle(
    async () => {
      transitions.push('enable')
      await registration.promise
    },
    async () => {
      transitions.push('disable')
    },
  )

  const enabling = lifecycle.enable()
  await flushTasks()
  const disabling = lifecycle.disable()
  registration.resolve()
  await Promise.all([enabling, disabling])

  assert.deepEqual(transitions, ['enable', 'disable'])
  assert.equal(lifecycle.state, 'disabled')
  assert.equal(lifecycle.wantEnable, false)
})

test('disconnect invalidates an in-flight registration and reconnect registers again', async () => {
  const firstRegistration = deferred()
  let enableCalls = 0
  const lifecycle = new ClusterLifecycle(
    async () => {
      enableCalls++
      if (enableCalls === 1) {
        await firstRegistration.promise
      }
    },
    async () => {},
  )

  const staleRegistration = lifecycle.enable()
  await flushTasks()
  lifecycle.markDisconnected()
  const reconnectRegistration = lifecycle.enable()
  firstRegistration.resolve()
  await Promise.all([staleRegistration, reconnectRegistration])

  assert.equal(enableCalls, 2)
  assert.equal(lifecycle.state, 'enabled')
  assert.equal(lifecycle.wantEnable, true)
})

test('failed transitions return to a retryable stable state', async () => {
  let enableCalls = 0
  let disableCalls = 0
  const lifecycle = new ClusterLifecycle(
    async () => {
      enableCalls++
      if (enableCalls === 1) throw new Error('registration failed')
    },
    async () => {
      disableCalls++
      if (disableCalls === 1) throw new Error('disable failed')
    },
  )

  await assert.rejects(lifecycle.enable(), /registration failed/)
  assert.equal(lifecycle.state, 'disabled')
  await lifecycle.enable()
  assert.equal(lifecycle.state, 'enabled')

  await assert.rejects(lifecycle.disable(), /disable failed/)
  assert.equal(lifecycle.state, 'enabled')
  await lifecycle.disable()
  assert.equal(lifecycle.state, 'disabled')
})
