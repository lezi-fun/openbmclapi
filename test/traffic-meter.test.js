import assert from 'node:assert/strict'
import test from 'node:test'
import {TrafficMeter} from '../dist/traffic-meter.js'

test('TrafficMeter accumulates independent data-plane increments', () => {
  const meter = new TrafficMeter()
  meter.record({hits: 2, bytes: 100})
  meter.record({hits: 1, bytes: 50})

  assert.deepEqual(meter.snapshot(), {hits: 3, bytes: 150})
})

test('TrafficMeter acknowledges one keep-alive snapshot and preserves newer traffic', () => {
  const meter = new TrafficMeter()
  meter.record({hits: 2, bytes: 100})
  const snapshot = meter.snapshot()
  meter.record({hits: 1, bytes: 50})

  meter.acknowledge(snapshot)

  assert.deepEqual(meter.snapshot(), {hits: 1, bytes: 50})
})
