import assert from 'node:assert/strict'
import test from 'node:test'
import {TokenManager} from '../dist/token.js'

function response(value) {
  return {
    async json() {
      if (value instanceof Error) throw value
      return value
    },
  }
}

function createTimerHarness() {
  const timers = []
  return {
    timers,
    schedule(callback, delay) {
      const timer = {
        callback,
        delay,
        cleared: false,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true
        },
      }
      timers.push(timer)
      return timer
    },
    cancel(timer) {
      timer.cleared = true
    },
  }
}

async function flushTasks() {
  await new Promise((resolve) => setImmediate(resolve))
}

test('concurrent initial token requests share one controller request', async () => {
  let resolveChallenge
  const challenge = new Promise((resolve) => {
    resolveChallenge = resolve
  })
  let challengeRequests = 0
  let tokenRequests = 0
  const timers = createTimerHarness()
  const client = {
    get() {
      challengeRequests++
      return {json: () => challenge}
    },
    post() {
      tokenRequests++
      return response({token: 'initial-token', ttl: 1_800_000})
    },
  }
  const manager = new TokenManager('cluster-id', 'cluster-secret', 'test', {
    client,
    schedule: timers.schedule,
    cancel: timers.cancel,
  })

  const first = manager.getToken()
  const second = manager.getToken()
  assert.equal(challengeRequests, 1)

  resolveChallenge({challenge: 'challenge'})
  assert.deepEqual(await Promise.all([first, second]), ['initial-token', 'initial-token'])
  assert.equal(tokenRequests, 1)
  assert.equal(timers.timers.length, 1)
  assert.equal(timers.timers[0].delay, 1_200_000)
  assert.equal(timers.timers[0].unrefCalled, true)
  manager.stop()
})

test('failed token refresh retries and successful refresh replaces the token', async () => {
  const timers = createTimerHarness()
  const refreshResponses = [new Error('controller unavailable'), {token: 'refreshed-token', ttl: 1_200_000}]
  let refreshRequests = 0
  const client = {
    get() {
      return response({challenge: 'challenge'})
    },
    post(_url, options) {
      if ('challenge' in options.json) {
        return response({token: 'initial-token', ttl: 1_800_000})
      }
      refreshRequests++
      return response(refreshResponses.shift())
    },
  }
  const manager = new TokenManager('cluster-id', 'cluster-secret', 'test', {
    client,
    schedule: timers.schedule,
    cancel: timers.cancel,
    refreshRetryDelay: 25,
  })

  assert.equal(await manager.getToken(), 'initial-token')
  timers.timers[0].callback()
  await flushTasks()

  assert.equal(refreshRequests, 1)
  assert.equal(timers.timers.length, 2)
  assert.equal(timers.timers[1].delay, 25)

  timers.timers[1].callback()
  await flushTasks()

  assert.equal(refreshRequests, 2)
  assert.equal(await manager.getToken(), 'refreshed-token')
  assert.equal(timers.timers.length, 3)
  assert.equal(timers.timers[2].delay, 600_000)
  manager.stop()
})

test('stopping the token manager cancels refresh scheduling', async () => {
  const timers = createTimerHarness()
  let refreshRequests = 0
  const client = {
    get() {
      return response({challenge: 'challenge'})
    },
    post(_url, options) {
      if (!('challenge' in options.json)) refreshRequests++
      return response({token: 'token', ttl: 1_800_000})
    },
  }
  const manager = new TokenManager('cluster-id', 'cluster-secret', 'test', {
    client,
    schedule: timers.schedule,
    cancel: timers.cancel,
  })

  await manager.getToken()
  const scheduledRefresh = timers.timers[0]
  manager.stop()

  assert.equal(scheduledRefresh.cleared, true)
  scheduledRefresh.callback()
  await flushTasks()
  assert.equal(refreshRequests, 0)
  assert.equal(timers.timers.length, 1)
})
