import assert from 'node:assert/strict'
import test from 'node:test'
import {Keepalive} from '../dist/keepalive.js'
import {TrafficMeter} from '../dist/traffic-meter.js'

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return {promise, resolve}
}

function nodeLifecycle() {
  const transitions = []
  return {
    node: {
      isEnabled: true,
      async disable() {
        transitions.push('disable')
      },
      connect() {
        transitions.push('connect')
      },
      async enable() {
        transitions.push('enable')
      },
      exit() {
        transitions.push('exit')
      },
    },
    transitions,
  }
}

test('Keepalive acknowledges only its successful traffic snapshot', async () => {
  const traffic = new TrafficMeter()
  traffic.record({hits: 2, bytes: 100})
  const {node, transitions} = nodeLifecycle()
  const payloads = []
  const keepalive = new Keepalive(60_000, node, traffic)
  keepalive.start({
    async keepAlive(payload) {
      payloads.push(payload)
      traffic.record({hits: 1, bytes: 50})
      return true
    },
  })

  try {
    await keepalive.emitKeepAlive()
  } finally {
    keepalive.stop()
  }

  assert.deepEqual(
    payloads.map(({hits, bytes}) => ({hits, bytes})),
    [{hits: 2, bytes: 100}],
  )
  assert.deepEqual(traffic.snapshot(), {hits: 1, bytes: 50})
  assert.deepEqual(transitions, [])
})

test('Keepalive preserves traffic when the controller rejects the heartbeat', async () => {
  const traffic = new TrafficMeter()
  traffic.record({hits: 2, bytes: 100})
  const {node, transitions} = nodeLifecycle()
  const keepalive = new Keepalive(60_000, node, traffic)
  keepalive.start({
    async keepAlive() {
      return false
    },
  })

  try {
    await keepalive.emitKeepAlive()
  } finally {
    keepalive.stop()
  }

  assert.deepEqual(traffic.snapshot(), {hits: 2, bytes: 100})
  assert.deepEqual(transitions, ['disable', 'connect', 'enable'])
})

test('Keepalive stop prevents an in-flight heartbeat from rescheduling or reconnecting', async () => {
  const traffic = new TrafficMeter()
  const entered = deferred()
  const response = deferred()
  const {node, transitions} = nodeLifecycle()
  const keepalive = new Keepalive(0, node, traffic)
  keepalive.start({
    async keepAlive() {
      entered.resolve()
      await response.promise
      throw new Error('connection closed during shutdown')
    },
  })

  await entered.promise
  keepalive.stop()
  response.resolve()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(keepalive.timer, undefined)
  assert.deepEqual(transitions, [])
})

test('Keepalive ignores an acknowledgement from an older connection generation', async () => {
  const traffic = new TrafficMeter()
  traffic.record({hits: 2, bytes: 100})
  const entered = deferred()
  const response = deferred()
  const {node, transitions} = nodeLifecycle()
  const keepalive = new Keepalive(60_000, node, traffic)
  keepalive.start({
    async keepAlive() {
      entered.resolve()
      await response.promise
      return true
    },
  })

  const oldHeartbeat = keepalive.emitKeepAlive()
  await entered.promise
  keepalive.start({
    async keepAlive() {
      return true
    },
  })
  response.resolve()
  await oldHeartbeat
  keepalive.stop()

  assert.deepEqual(traffic.snapshot(), {hits: 2, bytes: 100})
  assert.deepEqual(transitions, [])
})
