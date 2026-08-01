import assert from 'node:assert/strict'
import test from 'node:test'
import {refreshFileList} from '../dist/file-list.js'

test('incremental refresh syncs the returned delta instead of the previous list', async () => {
  const previous = {files: [{hash: 'old', mtime: 10, path: '/old', size: 1}]}
  const incremental = {files: [{hash: 'new', mtime: 20, path: '/new', size: 2}]}
  const sync = {concurrency: 2, source: 'origin'}
  const calls = []
  const client = {
    async getConfiguration() {
      return {sync}
    },
    async getFileList(lastModified) {
      calls.push(['getFileList', lastModified])
      return incremental
    },
    async syncFiles(fileList, syncConfig) {
      calls.push(['syncFiles', fileList, syncConfig])
    },
  }

  assert.equal(await refreshFileList(client, previous), incremental)
  assert.deepEqual(calls, [
    ['getFileList', 10],
    ['syncFiles', incremental, sync],
  ])
})

test('empty incremental refresh preserves the previous cursor state', async () => {
  const previous = {files: [{hash: 'old', mtime: 10, path: '/old', size: 1}]}
  const client = {
    async getConfiguration() {
      throw new Error('configuration must not be requested')
    },
    async getFileList() {
      return {files: []}
    },
    async syncFiles() {
      throw new Error('empty delta must not be synced')
    },
  }

  assert.equal(await refreshFileList(client, previous), previous)
})
