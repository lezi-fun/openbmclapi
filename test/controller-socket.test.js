import assert from 'node:assert/strict'
import test from 'node:test'
import {ControllerSocket} from '../dist/controller-socket.js'

class FakeEmitter {
  handlers = new Map()

  on(event, handler) {
    const handlers = this.handlers.get(event) ?? []
    handlers.push(handler)
    this.handlers.set(event, handlers)
    return this
  }

  trigger(event, ...args) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args)
    }
  }
}

class FakeSocket extends FakeEmitter {
  connected = false
  connectCalls = 0
  disconnectCalls = 0
  timeoutValue
  io = new FakeEmitter()
  calls = []
  acknowledgements = new Map()

  connect() {
    this.connectCalls++
    this.connected = true
    return this
  }

  disconnect() {
    this.disconnectCalls++
    this.connected = false
    return this
  }

  emitWithAck(event, payload) {
    this.calls.push([event, payload])
    const acknowledgement = this.acknowledgements.get(event)
    return acknowledgement instanceof Error ? Promise.reject(acknowledgement) : Promise.resolve(acknowledgement)
  }

  timeout(value) {
    this.timeoutValue = value
    return this
  }
}

function registrationPayload() {
  return {
    host: '127.0.0.1',
    port: 4000,
    version: '2.0.0',
    byoc: false,
    noFastEnable: false,
    flavor: {runtime: 'Node.js/v24', storage: 'file'},
  }
}

test('ControllerSocket keeps WebSocket auth and forwards lifecycle events', async () => {
  const socket = new FakeSocket()
  let connectionOptions
  const events = []
  const controller = new ControllerSocket(
    'https://controller.example',
    {
      async getToken() {
        return 'token'
      },
    },
    new AbortController().signal,
    {
      socketFactory(url, options) {
        assert.equal(url, 'https://controller.example')
        connectionOptions = options
        return socket
      },
      handlers: {
        onConnectionError: (event, error) => events.push([event, error.message]),
        onDisconnect: (reason) => events.push(['disconnect', reason]),
        onReconnect: (attempt) => events.push(['reconnect', attempt]),
      },
    },
  )

  controller.connect()
  assert.deepEqual(connectionOptions.transports, ['websocket'])
  const authentication = await new Promise((resolve) => connectionOptions.auth(resolve))
  assert.deepEqual(authentication, {token: 'token'})

  socket.trigger('disconnect', 'transport close')
  socket.io.trigger('reconnect', 3)
  socket.trigger('error', new Error('socket failed'))
  socket.io.trigger('reconnect_failed')
  assert.deepEqual(events, [
    ['disconnect', 'transport close'],
    ['reconnect', 3],
    ['error', 'socket failed'],
    ['reconnect_failed', 'reconnect failed'],
  ])

  controller.connect()
  assert.equal(socket.connectCalls, 1)
})

test('ControllerSocket preserves control-plane event names, payloads, and strict ACKs', async () => {
  const socket = new FakeSocket()
  socket.connected = true
  socket.acknowledgements.set('port-check', [null, true])
  socket.acknowledgements.set('request-cert', [null, {cert: 'certificate', key: 'private-key'}])
  socket.acknowledgements.set('enable', [null, true])
  socket.acknowledgements.set('keep-alive', [null, '2026-08-05T00:00:00.000Z'])
  socket.acknowledgements.set('disable', [null, true])
  const controller = new ControllerSocket(
    'https://controller.example',
    {
      async getToken() {
        return 'token'
      },
    },
    new AbortController().signal,
    {socketFactory: () => socket},
  )
  controller.connect()

  const registration = registrationPayload()
  await controller.portCheck(registration)
  assert.deepEqual(await controller.requestCert(), {cert: 'certificate', key: 'private-key'})
  await controller.enable(registration)
  assert.equal(socket.timeoutValue, 300_000)
  assert.equal(await controller.keepAlive({time: new Date(0), hits: 2, bytes: 128}), true)
  await controller.disable()

  assert.deepEqual(socket.calls, [
    ['port-check', registration],
    ['request-cert', undefined],
    ['enable', registration],
    ['keep-alive', {time: new Date(0), hits: 2, bytes: 128}],
    ['disable', null],
  ])
  assert.equal(socket.disconnectCalls, 1)
})

test('ControllerSocket preserves registration timeout, cancellation, and strict enable ACK behavior', async () => {
  const disconnectedController = new ControllerSocket(
    'https://controller.example',
    {
      async getToken() {
        return 'token'
      },
    },
    new AbortController().signal,
  )
  await assert.rejects(disconnectedController.enable(registrationPayload()), /未连接到服务器/)

  const timeoutSocket = new FakeSocket()
  timeoutSocket.acknowledgements.set('enable', new Error('timeout'))
  const timeoutController = new ControllerSocket(
    'https://controller.example',
    {
      async getToken() {
        return 'token'
      },
    },
    new AbortController().signal,
    {socketFactory: () => timeoutSocket},
  )
  timeoutController.connect()
  await assert.rejects(timeoutController.enable(registrationPayload()), /节点注册超时/)

  const rejectedSocket = new FakeSocket()
  rejectedSocket.acknowledgements.set('enable', [null, 1])
  const rejectedController = new ControllerSocket(
    'https://controller.example',
    {
      async getToken() {
        return 'token'
      },
    },
    new AbortController().signal,
    {socketFactory: () => rejectedSocket},
  )
  rejectedController.connect()
  await assert.rejects(rejectedController.enable(registrationPayload()), /节点注册失败/)

  rejectedSocket.connected = true
  rejectedSocket.acknowledgements.set('disable', [null, 1])
  await assert.rejects(rejectedController.disable(), /节点禁用失败/)
  assert.equal(rejectedSocket.connected, true)

  const abortController = new AbortController()
  const abortedSocket = new FakeSocket()
  abortedSocket.emitWithAck = () => new Promise(() => {})
  const cancelledController = new ControllerSocket(
    'https://controller.example',
    {
      async getToken() {
        return 'token'
      },
    },
    abortController.signal,
    {socketFactory: () => abortedSocket},
  )
  cancelledController.connect()
  const pending = cancelledController.enable(registrationPayload())
  const reason = new Error('shutdown')
  abortController.abort(reason)
  await assert.rejects(pending, (error) => error === reason)
})
