import assert from 'node:assert/strict'
import test from 'node:test'
import {clusterVersion} from '../dist/version.js'

test('the reported cluster release version is 2.0.0', () => {
  assert.equal(clusterVersion, '2.0.0')
})
