import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageProbeMonitor } from '../../src/lib/oauth/usage-probe-monitor.mjs'
import { createCredentialRefreshMonitor } from '../../src/lib/oauth/credential-refresh-monitor.mjs'
import { createVmAdapter } from '../../src/lib/ip-pool/vm-adapter.mjs'

const live = {
  id: 'vm-01',
  status: 'running',
  has_refresh: true,
  has_token: true,
  proxy: { host: '127.0.0.1', port: 24100 },
  expires_at: 1,
}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

test('usage probe rechecks maintenance when queued work gets a worker', async () => {
  const blocked = new Set()
  const called = []
  let finish
  const monitor = createUsageProbeMonitor({
    config: { concurrency: 1, enabled: false },
    listTargets: () => [live, { ...live, id: 'vm-02' }],
    isMaintenance: (id) => blocked.has(id),
    probeOne: (vm) => {
      called.push(vm.id)
      return new Promise((resolve) => {
        finish = resolve
      })
    },
  })
  const first = monitor.probeNow('vm-01')
  const queued = monitor.probeNow('vm-02')
  await nextTurn()
  assert.equal(monitor.inflightForVm('vm-01'), 1)
  blocked.add('vm-02')
  finish({ ok: true })
  await first
  assert.equal((await queued).reason, 'ip_pool_maintenance')
  assert.deepEqual(called, ['vm-01'])
  assert.equal(monitor.inflightForVm('vm-01'), 0)
  assert.equal(monitor.start().reason, 'disabled')
})

test('timed-out usage probe remains in drain accounting until its real request settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finish
  const monitor = createUsageProbeMonitor({
    config: { timeout_ms: 10000 },
    listTargets: () => [live],
    probeOne: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  })
  const result = monitor.probeNow('vm-01')
  await nextTurn()
  t.mock.timers.tick(10000)
  assert.equal((await result).error, 'probe_timeout')
  assert.equal(monitor.inflightForVm('vm-01'), 1)
  finish({ ok: true })
  await nextTurn()
  assert.equal(monitor.inflightForVm('vm-01'), 0)
})

test('credential refresh holds queued work and exposes live refresh for drain', async () => {
  let blocked = false
  let finish
  const called = []
  const monitor = createCredentialRefreshMonitor({
    config: { concurrency: 1, enabled: false },
    listTargets: () => [live, { ...live, id: 'vm-02' }],
    isMaintenance: () => blocked,
    refreshOne: (vm) => {
      called.push(vm.id)
      return new Promise((resolve) => {
        finish = resolve
      })
    },
  })
  const run = monitor.runOnce()
  await nextTurn()
  assert.equal(monitor.inflightForVm('vm-01'), 1)
  blocked = true
  finish({ ok: true })
  await run
  assert.deepEqual(called, ['vm-01'])
  assert.equal(monitor.inflightForVm('vm-01'), 0)
  assert.equal((await monitor.runOnce()).due, 0)
  assert.equal(monitor.start().reason, 'disabled')
})

test('adapter reports background still active even when model inflight is zero', async () => {
  let active = 1
  const adapter = createVmAdapter({
    projectRoot: '/unused',
    getScheduler: () => ({ vmInflight: new Map() }),
    getMonitors: () => [{ inflightForVm: () => active }],
    ops: { platform: 'linux', getVm: () => ({ ...live, ip_pool_maintenance: { operation_id: 'op-1' } }) },
  })
  assert.deepEqual(await adapter.drain('vm-01', { timeoutMs: 0 }), { ok: false, inflight: 0, background_inflight: 1 })
  active = 0
  assert.deepEqual(await adapter.drain('vm-01', { timeoutMs: 0 }), { ok: true, inflight: 0 })
})
