import assert from 'node:assert/strict'
import {copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {NginxService, parseNginxAccessLog, renderNginxConfig} from '../dist/nginx-service.js'
import {TrafficMeter} from '../dist/traffic-meter.js'

test('Nginx access log parsing preserves hit and byte accounting', () => {
  assert.deepEqual(
    parseNginxAccessLog(
      '127.0.0.1 - - [05/Aug/2026:03:40:43 +0000] "GET /download/hash HTTP/1.1" 206 42 "-" "openbmclapi-test"',
    ),
    {bytes: 42},
  )
  assert.deepEqual(
    parseNginxAccessLog(
      '127.0.0.1 - - [05/Aug/2026:03:40:43 +0000] "HEAD /download/hash HTTP/1.1" 200 - "-" "openbmclapi-test"',
    ),
    {bytes: 0},
  )
  assert.equal(parseNginxAccessLog('not an nginx access log'), undefined)
})

test('Nginx config rendering preserves socket, TLS, and unbuffered proxy behavior', async () => {
  const source = await readFile(new URL('../nginx/nginx.conf', import.meta.url), 'utf8')
  const rendered = renderNginxConfig(source, {
    root: '/srv/openbmclapi',
    port: 4000,
    ssl: true,
    sock: '/tmp/openbmclapi.sock',
    user: 'openbmclapi',
    tmpdir: '/tmp/openbmclapi',
  })

  assert.match(rendered, /server unix:\/tmp\/openbmclapi\.sock;/)
  assert.match(rendered, /listen 4000 default ssl http2;/)
  assert.equal((rendered.match(/proxy_buffering off;/g) ?? []).length, 2)
  assert.doesNotMatch(rendered, /<%|<%=/)
})

test('NginxService owns startup configuration, access metrics, and idempotent shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openbmclapi-nginx-test-'))
  const templateDirectory = join(root, 'templates')
  const appRoot = join(root, 'app')
  const socketPath = join(root, 'openbmclapi.sock')
  await writeFile(
    join(root, 'template.conf'),
    'user <%= user %>; listen <%= port %>; upstream unix:<%= sock %>; <% if (ssl) { %>ssl on;<% } %>',
  )
  await mkdir(templateDirectory, {recursive: true})
  await mkdir(appRoot, {recursive: true})
  await copyFile(join(root, 'template.conf'), join(templateDirectory, 'nginx.conf'))

  let killed = 0
  let unwatched = 0
  let spawnedArgs
  const lines = new Map()
  const fakeTail = {
    on(event, callback) {
      lines.set(event, callback)
    },
    unwatch() {
      unwatched++
    },
  }
  const fakeProcess = {
    exitCode: null,
    kill() {
      killed++
      return true
    },
  }
  const traffic = new TrafficMeter()
  const service = new NginxService({
    disableAccessLog: true,
    socketPath,
    templateDirectory,
    traffic,
    tmpDir: join(root, 'certs'),
    spawnProcess(command, args) {
      spawnedArgs = [command, ...args]
      return fakeProcess
    },
    tailFactory() {
      return fakeTail
    },
    async wait() {},
  })

  try {
    assert.equal(await service.start(appRoot, 4000, 'https'), socketPath)
    assert.deepEqual(spawnedArgs?.slice(0, 2), ['nginx', '-c'])
    assert.match(await readFile(spawnedArgs[2], 'utf8'), /listen 4000;.*ssl on;/)
    lines.get('line')('127.0.0.1 - - [05/Aug/2026:03:40:43 +0000] "GET / HTTP/1.1" 200 7 "-" "test"')
    assert.deepEqual(traffic.snapshot(), {hits: 1, bytes: 7})
  } finally {
    service.stop()
    service.stop()
    await rm(root, {recursive: true, force: true})
  }

  assert.equal(killed, 1)
  assert.equal(unwatched, 1)
})
