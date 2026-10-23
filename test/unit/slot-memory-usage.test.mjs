import test from 'node:test'
import assert from 'node:assert/strict'
import { createSlotMemoryCollector, memoryUsageSnapshot } from '../../src/lib/vm/slot-memory-usage.mjs'

test('reports total cgroup usage without subtracting cache, actual limit and stopped state', () => {
  const inspect = { State: { Running: true }, HostConfig: { Memory: 1024 } }
  assert.deepEqual(
    memoryUsageSnapshot(inspect, { memory_stats: { usage: 900, stats: { inactive_file: 200 } } }, 'now'),
    { status: 'ok', used_bytes: 900, limit_bytes: 1024, sampled_at: 'now' },
  )
  assert.equal(
    memoryUsageSnapshot({ ...inspect, HostConfig: { Memory: 0 } }, { memory_stats: { usage: 0 } }).limit_bytes,
    0,
  )
  assert.equal(memoryUsageSnapshot(inspect, {}).status, 'unavailable')
  assert.equal(memoryUsageSnapshot({ ...inspect, State: { Running: false } }, {}).status, 'stopped')
})

test('shares concurrent polling, isolates hosts, expires cache, and recovers after failure', async () => {
  let time = 1000,
    calls = 0,
    fail = false
  const collect = createSlotMemoryCollector({
    now: () => time,
    hostFor: (vm) => ({ kind: 'local', dockerApi: () => vm.node_id || 'local' }),
    request: async (host, { path }) => {
      calls++
      if (fail) throw new Error('offline')
      return path.endsWith('/json')
        ? { State: { Running: true }, HostConfig: { Memory: 1024 } }
        : { memory_stats: { usage: host === 'other' ? 600 : 200 } }
    },
  })
  const vm = { id: 'vm-01' }
  const [a, b] = await Promise.all([collect([vm]), collect([vm])])
  assert.equal(calls, 2)
  assert.equal(a.get(vm.id).used_bytes, b.get(vm.id).used_bytes)
  assert.equal((await collect([{ ...vm, node_id: 'other' }])).get(vm.id).used_bytes, 600)
  time += 10_001
  fail = true
  assert.equal((await collect([vm])).get(vm.id).status, 'unavailable')
  time += 10_001
  fail = false
  assert.equal((await collect([vm])).get(vm.id).used_bytes, 200)
})
