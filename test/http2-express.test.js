import assert from 'node:assert/strict'
import {connect, createServer} from 'node:http2'
import test from 'node:test'
import express from 'express'
import http2Express from 'http2-express'

test('Express 5 handles HTTP/2 requests through the adapter', async () => {
  const app = http2Express(express)
  app.get('/protocol', (req, res) => {
    res.json({hostname: req.hostname, protocol: req.httpVersion})
  })

  const server = createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  assert(address && typeof address !== 'string')
  const client = connect(`http://127.0.0.1:${address.port}`)

  try {
    const response = await new Promise((resolve, reject) => {
      const request = client.request({
        ':authority': 'cache.example.test',
        ':path': '/protocol',
      })
      const chunks = []
      let headers

      request.on('response', (value) => {
        headers = value
      })
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => resolve({body: Buffer.concat(chunks), headers}))
      request.on('error', reject)
      request.end()
    })

    assert.equal(response.headers[':status'], 200)
    assert.deepEqual(JSON.parse(response.body.toString()), {
      hostname: 'cache.example.test',
      protocol: '2.0',
    })
  } finally {
    client.close()
    await new Promise((resolve) => server.close(resolve))
  }
})
