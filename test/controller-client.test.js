import assert from 'node:assert/strict'
import {compress} from '@mongodb-js/zstd'
import test from 'node:test'
import {FileListSchema} from '../dist/constants.js'
import {ControllerClient, shouldAuthorizeControllerUrl} from '../dist/controller-client.js'

function fakeRequest(response, progress) {
  const request = Promise.resolve(response)
  request.on = (event, listener) => {
    if (event === 'downloadProgress' && progress !== undefined) {
      listener({transferred: progress})
    }
    return request
  }
  return request
}

test('ControllerClient preserves REST paths, payloads, file-list decoding, and progress', async () => {
  const files = [{path: '/file.jar', hash: 'a'.repeat(32), size: 10, mtime: 20}]
  const encodedFiles = await compress(FileListSchema.toBuffer(files))
  const calls = []
  const client = {
    get(path, options) {
      calls.push(['get', path, options])
      if (path === 'openbmclapi/files') {
        return fakeRequest({statusCode: 200, body: encodedFiles})
      }
      if (path === 'openbmclapi/configuration') {
        return fakeRequest({statusCode: 200, body: {sync: {source: 'controller', concurrency: 4}}})
      }
      if (path === 'source/file.jar') {
        return fakeRequest({statusCode: 200, body: Buffer.from('file'), request: {}}, 4)
      }
      if (path === `openbmclapi/download/${'b'.repeat(32)}`) {
        return fakeRequest({statusCode: 200, body: Buffer.from('on-demand')})
      }
      throw new Error(`unexpected GET ${path}`)
    },
    post(path, options) {
      calls.push(['post', path, options])
      return fakeRequest({statusCode: 200, body: Buffer.alloc(0)})
    },
  }
  const controller = new ControllerClient(
    '2.0.0',
    {
      async getToken() {
        return 'token'
      },
    },
    new AbortController().signal,
    {client, prefixUrl: 'https://controller.example/base/'},
  )

  assert.deepEqual(JSON.parse(JSON.stringify(await controller.getFileList(123))), {files})
  assert.deepEqual(await controller.getConfiguration(), {sync: {source: 'controller', concurrency: 4}})
  let transferred = 0
  const download = await controller.downloadFile('/source/file.jar', (value) => {
    transferred = value
  })
  assert.equal(download.body.toString(), 'file')
  assert.equal(transferred, 4)
  assert.equal((await controller.downloadOnDemand('b'.repeat(32))).toString(), 'on-demand')
  await controller.reportDownloadError('/source/file.jar', [new URL('https://cdn.example/file.jar')], 'failed')

  assert.equal(calls[0][2].searchParams.lastModified, 123)
  assert.equal(calls[2][1], 'source/file.jar')
  assert.equal(calls[2][2].retry.limit, 0)
  assert.deepEqual(calls[3][2].searchParams, {noopen: 1})
  assert.deepEqual(calls[4][2].json.urls, [
    'https://controller.example/source/file.jar',
    'https://cdn.example/file.jar',
  ])
  assert.equal(JSON.parse(calls[4][2].json.error).message, 'failed')
})

test('ControllerClient treats a 204 file-list response as an empty increment', async () => {
  const client = {
    get() {
      return fakeRequest({statusCode: 204, body: Buffer.alloc(0)})
    },
  }
  const controller = new ControllerClient(
    '2.0.0',
    {
      async getToken() {
        return 'token'
      },
    },
    new AbortController().signal,
    {client},
  )

  assert.deepEqual(await controller.getFileList(123), {files: []})
})

test('controller authorization uses exact custom hosts and safe official-domain matching', () => {
  assert.equal(shouldAuthorizeControllerUrl(new URL('https://custom.example/path'), 'custom.example'), true)
  assert.equal(shouldAuthorizeControllerUrl(new URL('https://openbmclapi.bangbang93.com/path'), 'custom.example'), true)
  assert.equal(shouldAuthorizeControllerUrl(new URL('http://localhost/path'), 'custom.example'), true)
  assert.equal(shouldAuthorizeControllerUrl(new URL('https://evilbangbang93.com/path'), 'custom.example'), false)
  assert.equal(shouldAuthorizeControllerUrl(new URL('https://cdn.example/path'), 'custom.example'), false)
})
