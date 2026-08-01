import assert from 'node:assert/strict'
import test from 'node:test'
import {minioObjectHash, minioObjectKey, minioObjectPrefix, minioRelativePath} from '../dist/storage/minio-path.js'

test('MinIO keys remain POSIX paths on every platform', () => {
  assert.equal(minioObjectPrefix('/cache/root/'), 'cache/root/')
  assert.equal(minioObjectKey('/cache/root/', '/ab/abcdef'), 'cache/root/ab/abcdef')
  assert.equal(minioObjectKey('/cache/root/', '\\ab\\abcdef'), 'cache/root/ab/abcdef')
})

test('MinIO GC compares the basename hash within the exact prefix', () => {
  const path = minioRelativePath('cache/root', 'cache/root/ab/abcdef')
  assert.equal(path, 'ab/abcdef')
  assert.equal(minioObjectHash(path), 'abcdef')
  assert.equal(minioRelativePath('cache/root', 'cache/root-other/ab/abcdef'), undefined)
})
