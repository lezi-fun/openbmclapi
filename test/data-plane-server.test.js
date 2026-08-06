import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import test from 'node:test'
import {DataPlaneServer} from '../dist/data-plane-server.js'
import {TrafficMeter} from '../dist/traffic-meter.js'

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return {promise, resolve}
}

function signedUrl(origin, hash, secret, name) {
  const expires = (Date.now() + 60_000).toString(36)
  const signature = sign(secret, hash, expires)
  const url = new URL(`/download/${hash}`, origin)
  url.searchParams.set('s', signature)
  url.searchParams.set('e', expires)
  if (name) url.searchParams.set('name', name)
  return url
}

function sign(secret, value, expires) {
  return createHash('sha1').update(secret).update(value).update(expires).digest('base64url')
}

test('DataPlaneServer preserves signed downloads, single-flight origin fetches, and counters', async () => {
  const secret = 'cluster-secret'
  const hash = 'a'.repeat(32)
  const download = deferred()
  const twoExistenceChecks = deferred()
  const servedRequests = []
  let existsCalls = 0
  let downloadCalls = 0
  let trackedCalls = 0
  const traffic = new TrafficMeter()
  const signal = new AbortController().signal
  const storage = {
    async exists() {
      existsCalls++
      if (existsCalls === 2) twoExistenceChecks.resolve()
      return false
    },
    async serve(request, response) {
      servedRequests.push(request)
      response.status(200).send('cached')
      return {bytes: 6, hits: 1}
    },
  }
  const dataPlane = new DataPlaneServer({
    certDirectory: '.',
    config: {clusterSecret: secret, disableAccessLog: true},
    async downloadFile() {
      downloadCalls++
      await download.promise
    },
    runtime: {
      signal,
      track(task) {
        trackedCalls++
        return task
      },
    },
    storage,
    traffic,
  })
  const server = dataPlane.setup(false)
  await dataPlane.listen(0, '127.0.0.1')
  const address = server.address()
  assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`

  try {
    const invalid = await fetch(`${origin}/download/${hash}`)
    assert.equal(invalid.status, 403)

    const url = signedUrl(origin, hash, secret, 'client.jar')
    const auth = await fetch(`${origin}/auth`, {
      headers: {'x-original-uri': url.pathname + url.search},
    })
    assert.equal(auth.status, 204)

    const measureExpires = (Date.now() + 60_000).toString(36)
    const measurePath = '/measure/1'
    const measureUrl = new URL(measurePath, origin)
    measureUrl.searchParams.set('s', sign(secret, measurePath, measureExpires))
    measureUrl.searchParams.set('e', measureExpires)
    const measure = await fetch(measureUrl)
    assert.equal(measure.status, 200)
    assert.equal(measure.headers.get('content-length'), String(1024 * 1024))
    assert.equal((await measure.arrayBuffer()).byteLength, 1024 * 1024)

    const first = fetch(url, {headers: {range: 'bytes=0-5'}})
    const second = fetch(url, {headers: {range: 'bytes=0-5'}})
    await twoExistenceChecks.promise
    assert.equal(downloadCalls, 1)
    assert.equal(trackedCalls, 1)
    download.resolve()

    const responses = await Promise.all([first, second])
    assert.deepEqual(await Promise.all(responses.map(async (response) => await response.text())), ['cached', 'cached'])
    assert.deepEqual(
      responses.map((response) => response.headers.get('x-bmclapi-hash')),
      [hash, hash],
    )
    assert.deepEqual(traffic.snapshot(), {hits: 2, bytes: 12})
    assert.equal(servedRequests.length, 2)
    assert.equal(servedRequests[0].hashPath, `aa/${hash}`)
    assert.equal(servedRequests[0].range, 'bytes=0-5')
    assert.equal(servedRequests[0].attachmentName, 'client.jar')
    assert.equal(servedRequests[0].signal, signal)
  } finally {
    await dataPlane.close()
  }
  assert.equal(server.listening, false)
})

test('DataPlaneServer requires setup before listening and can close before setup', async () => {
  const dataPlane = new DataPlaneServer({
    certDirectory: '.',
    config: {clusterSecret: 'secret', disableAccessLog: true},
    async downloadFile() {},
    runtime: {
      signal: new AbortController().signal,
      track: (task) => task,
    },
    storage: {},
    traffic: new TrafficMeter(),
  })

  await assert.rejects(dataPlane.listen(0), /server not setup/)
  await dataPlane.close()
})
