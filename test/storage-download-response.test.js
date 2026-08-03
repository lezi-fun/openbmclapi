import assert from 'node:assert/strict'
import {Readable, Writable} from 'node:stream'
import test from 'node:test'
import {AlistWebdavStorage} from '../dist/storage/alist-webdav.storage.js'
import {
  applyAttachmentHeader,
  attachmentHeader,
  copyDownloadHeaders,
  normalizeAttachmentName,
  requestedDownloadBytes,
  successfulDownload,
} from '../dist/storage/download-response.js'
import {MinioStorage} from '../dist/storage/minio.storage.js'
import {OssStorage} from '../dist/storage/oss.storage.js'

function request(overrides = {}) {
  return {
    hash: 'a'.repeat(32),
    hashPath: `aa/${'a'.repeat(32)}`,
    method: 'GET',
    ...overrides,
  }
}

function response() {
  const headers = new Map()
  return {
    headers,
    set(name, value) {
      headers.set(name.toLowerCase(), value)
      return this
    },
  }
}

test('download byte accounting has stable full, range, malformed, and HEAD semantics', () => {
  assert.equal(requestedDownloadBytes(100, request()), 100)
  assert.equal(requestedDownloadBytes(100, request({range: 'bytes=0-9'})), 10)
  assert.equal(requestedDownloadBytes(100, request({range: 'bytes=0-9,20-29'})), 20)
  assert.equal(requestedDownloadBytes(100, request({range: 'bytes=-10'})), 10)
  assert.equal(requestedDownloadBytes(100, request({range: 'bytes=90-'})), 10)
  assert.equal(requestedDownloadBytes(100, request({range: 'bytes=200-300'})), 0)
  assert.equal(requestedDownloadBytes(100, request({range: 'invalid'})), 100)
  assert.equal(requestedDownloadBytes(100, request({method: 'HEAD', range: 'bytes=0-9'})), 0)
  assert.deepEqual(successfulDownload(100, request({range: 'bytes=10-19'})), {bytes: 10, hits: 1})
})

test('attachment names are normalized and encoded without header injection', () => {
  assert.equal(normalizeAttachmentName(undefined), undefined)
  assert.equal(normalizeAttachmentName(['file.jar']), undefined)
  assert.equal(normalizeAttachmentName(''), undefined)

  const name = '测试"\r\n.jar'
  const normalized = normalizeAttachmentName(name)
  assert.equal(normalized, name)
  const header = attachmentHeader(normalized)
  assert.equal(header.includes('\r'), false)
  assert.equal(header.includes('\n'), false)
  assert.match(header, /^attachment; filename=".*"; filename\*=UTF-8''/)
  assert.match(header, /%E6%B5%8B%E8%AF%95/)
})

test('download response headers use the shared attachment value and a strict upstream allowlist', () => {
  const res = response()
  const download = request({attachmentName: 'client name.jar'})

  copyDownloadHeaders(
    {
      'content-length': '10',
      'content-range': 'bytes 0-9/100',
      'content-type': 'application/java-archive',
      'content-disposition': 'inline',
      connection: 'close',
    },
    res,
  )
  applyAttachmentHeader(res, download)

  assert.equal(res.headers.get('content-length'), '10')
  assert.equal(res.headers.get('content-range'), 'bytes 0-9/100')
  assert.equal(res.headers.get('content-type'), 'application/java-archive')
  assert.equal(res.headers.has('connection'), false)
  assert.equal(res.headers.get('content-disposition'), attachmentHeader('client name.jar'))
})

test('MinIO redirects use the normalized attachment and range accounting contract', async () => {
  const storage = new MinioStorage({url: 'http://access:secret@localhost:9000/bucket/cache'})
  const download = request({range: 'bytes=10-19', attachmentName: 'client name.jar'})
  const calls = []
  storage.files.set(download.hash, {size: 100, path: '/original-name.jar'})
  storage.client.presignedGetObject = async (...args) => {
    calls.push(args)
    return 'https://objects.example/download'
  }
  const res = {
    redirectUrl: undefined,
    redirect(url) {
      this.redirectUrl = url
    },
  }

  assert.deepEqual(await storage.serve(download, res), {bytes: 10, hits: 1})
  assert.equal(res.redirectUrl, 'https://objects.example/download')
  assert.equal(calls[0][0], 'bucket')
  assert.equal(calls[0][1], `cache/${download.hashPath}`)
  assert.equal(calls[0][2], 60)
  assert.equal(calls[0][3]['response-content-disposition'], attachmentHeader('client name.jar'))
})

test('OSS redirects use the requested attachment name instead of stored path metadata', async () => {
  const storage = new OssStorage({
    accessKeyId: 'access',
    accessKeySecret: 'secret',
    bucket: 'bucket',
    region: 'oss-cn-hangzhou',
    prefix: 'cache',
    proxy: false,
  })
  const download = request({range: 'bytes=20-29', attachmentName: 'client name.jar'})
  const calls = []
  storage.files.set(download.hash, {size: 100, path: '/original-name.jar'})
  storage.client.signatureUrl = (...args) => {
    calls.push(args)
    return 'https://objects.example/download'
  }
  const res = {
    redirectUrl: undefined,
    redirect(url) {
      this.redirectUrl = url
    },
  }

  assert.deepEqual(await storage.serve(download, res), {bytes: 10, hits: 1})
  assert.equal(res.redirectUrl, 'https://objects.example/download')
  assert.equal(calls[0][0], `cache/${download.hashPath}`)
  assert.equal(calls[0][1].expires, 60)
  assert.equal(calls[0][1].response['content-disposition'], attachmentHeader('client name.jar'))
})

test('AList cached redirects use the same logical range accounting', async () => {
  const storage = new AlistWebdavStorage({url: 'http://localhost', basePath: '/cache', cacheTtl: 1_000})
  const download = request({range: 'bytes=30-39'})
  storage.files.set(download.hash, {size: 100, path: '/original-name.jar'})
  storage.redirectUrlCache.get = async () => 'https://objects.example/download'
  const res = {
    statusCode: undefined,
    redirectUrl: undefined,
    status(code) {
      this.statusCode = code
      return this
    },
    location(url) {
      this.redirectUrl = url
      return this
    },
    send() {
      return this
    },
  }

  assert.deepEqual(await storage.serve(download, res), {bytes: 10, hits: 1})
  assert.equal(res.statusCode, 302)
  assert.equal(res.redirectUrl, 'https://objects.example/download')
})

test('OSS proxy forwards Range and preserves upstream partial-response headers', async () => {
  const storage = new OssStorage({
    accessKeyId: 'access',
    accessKeySecret: 'secret',
    bucket: 'bucket',
    region: 'oss-cn-hangzhou',
    prefix: 'cache',
    proxy: true,
  })
  const download = request({range: 'bytes=40-49', attachmentName: 'client.jar'})
  const calls = []
  storage.files.set(download.hash, {size: 100, path: '/original-name.jar'})
  storage.client.getStream = async (...args) => {
    calls.push(args)
    return {
      stream: Readable.from([Buffer.alloc(10)]),
      res: {
        status: 206,
        headers: {
          'content-length': '10',
          'content-range': 'bytes 40-49/100',
          'content-type': 'application/octet-stream',
        },
      },
    }
  }
  const body = []
  const headers = new Map()
  const res = new Writable({
    write(chunk, _encoding, callback) {
      body.push(Buffer.from(chunk))
      callback()
    },
  })
  res.status = (code) => {
    res.statusCode = code
    return res
  }
  res.set = (name, value) => {
    headers.set(name.toLowerCase(), value)
    return res
  }

  assert.deepEqual(await storage.serve(download, res), {bytes: 10, hits: 1})
  assert.equal(calls[0][1].headers.Range, 'bytes=40-49')
  assert.equal(res.statusCode, 206)
  assert.equal(headers.get('content-length'), '10')
  assert.equal(headers.get('content-range'), 'bytes 40-49/100')
  assert.equal(headers.get('content-disposition'), attachmentHeader('client.jar'))
  assert.equal(Buffer.concat(body).length, 10)
})
