import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createVmAdapter } from '../../src/lib/ip-pool/vm-adapter.mjs'
import { getVm, patchVmRecord } from '../../src/lib/vm/vm-registry.mjs'
import { evaluateSlotGate } from '../../src/lib/pool/schedule-eligibility.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'

function fixture(t, overrides = {}, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-pool-vm-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  const vm = {
    id: 'vm-01',
    status: 'running',
    runtime: { type: 'docker' },
    timezone: 'America/New_York',
    fingerprint: { timezone: 'America/New_York' },
    schedulable: false,
    schedule_disabled_reason: 'oauth_revoked',
    schedule_manual: true,
    temp_unschedulable_until: '2099-01-01',
    temp_unschedulable_reason: 'quota_wait',
    proxy: { id: 'old', host: '127.0.0.1', port: 24099 },
    ...overrides,
  }
  fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify(vm))
  const events = []
  let proxy = vm.proxy
  let runtimeTimezone = vm.timezone
  const rows = {
    old: { ...proxy, bound_vm_ids: ['vm-01'] },
    fresh: { id: 'fresh', host: '127.0.0.1', port: 24100, bound_vm_ids: [] },
  }
  const pool = {
    detectGeo: async (id, opts) => {
      assert.equal(id, 'fresh')
      assert.deepEqual(opts, { force: true, expectedIp: '203.0.113.9' })
      events.push('geo')
      return options.geo || { ok: true, geo: { ip: opts.expectedIp, timezone: 'America/New_York' } }
    },
    ensureSocks: () => {
      events.push('ensureSocks')
      return { ok: true, proxy: rows.fresh }
    },
    bind: (id) => {
      rows.old.bound_vm_ids = []
      rows[id].bound_vm_ids = ['vm-01']
      proxy = rows[id]
      events.push('bind')
      return { ok: true }
    },
    getProxyForVm: () => proxy,
    getProxyByIdWithAuth: (id) => rows[id],
    unbindVm: () => {
      rows.old.bound_vm_ids = []
      rows.fresh.bound_vm_ids = []
      proxy = null
    },
  }
  const recreate = async (latest) => {
    events.push('recreate')
    if (!options.staleRuntime) runtimeTimezone = latest.timezone
    return options.worker || { ok: true }
  }
  const adapter = createVmAdapter({
    projectRoot: root,
    proxyPool: pool,
    getScheduler: () => ({ vmInflight: new Map() }),
    ops: {
      platform: 'linux',
      readTimezone: () => runtimeTimezone,
      ...(options.useDefaultRecreate
        ? {
            startSlotReady: async (latest, passedRoot, opts) => {
              assert.equal(passedRoot, root)
              assert.equal(opts.recreate, true)
              await recreate(latest)
              return { ok: true, runtime: { type: 'docker', container_id: 'new-container' } }
            },
          }
        : { recreate }),
      inspect: () => ({ running: vm.status === 'running' }),
      ensureProxyEgress: async () => {
        events.push('egress')
        return { ok: true }
      },
      reload: async () => {
        events.push('reload')
        return { ok: true }
      },
      probeSlotExit: async () => ({ ok: true, exit_ip: '203.0.113.9' }),
      stopProxyEgress: async () => {
        events.push('stop')
        return { ok: true }
      },
      drainEgress: async () => {
        events.push('drained')
        return { ok: true }
      },
    },
  })
  return { root, vm, adapter, events, rows }
}

test('maintenance preserves all original holds and restores only its own marker', async (t) => {
  const { root, vm, adapter } = fixture(t)
  await adapter.hold(vm.id, 'op-1')
  assert.equal(getVm(root, vm.id).schedulable, false)
  await assert.rejects(adapter.hold(vm.id, 'op-2'), { code: 'ip_pool_operation_busy' })
  assert.equal((await adapter.restore(vm.id, 'op-2')).ok, false)
  assert.equal(getVm(root, vm.id).ip_pool_maintenance.operation_id, 'op-1')
  assert.deepEqual(await adapter.restore(vm.id, 'op-1'), { ok: true })
  const after = { ...getVm(root, vm.id) }
  delete after.updated_at
  assert.deepEqual(after, vm)
})

test('maintenance is re-read at atomic reservation for master pins', async (t) => {
  const { root, vm, adapter } = fixture(t)
  const candidate = { vmId: vm.id, vm: { ...vm }, accountId: 'account-1', maxConcurrency: 5 }
  await adapter.hold(vm.id, 'op-1')
  assert.equal(evaluateSlotGate(getVm(root, vm.id)).reason, 'ip_pool_maintenance')
  const scheduler = Object.create(PoolScheduler.prototype)
  scheduler.projectRoot = root
  assert.equal(scheduler.reserve(candidate, { pinned: true, skipQuota: true }), null)
  assert.deepEqual(await scheduler.checkEligibility({ vm: candidate.vm, pinned: true }), {
    ok: false,
    reason: 'ip_pool_maintenance',
  })
})

test('bind/reload and actual slot exit verification never clear prior hold', async (t) => {
  const { root, vm, adapter, events } = fixture(t)
  await assert.rejects(adapter.apply(vm.id, { port: 24100 }), { code: 'ip_pool_maintenance_required' })
  const capture = await adapter.capture(vm.id)
  assert.equal(capture.claude, undefined)
  await adapter.hold(vm.id, 'op-1')
  assert.deepEqual(await adapter.drain(vm.id), { ok: true, inflight: 0 })
  assert.equal((await adapter.apply(vm.id, { port: 24100 }, '203.0.113.9')).proxy_id, 'fresh')
  assert.deepEqual(events, ['ensureSocks', 'egress', 'geo', 'bind', 'reload'])
  assert.equal(getVm(root, vm.id).timezone_source, 'proxy_geo')
  assert.equal((await adapter.verify(vm.id, '203.0.113.10')).code, 'exit_ip_mismatch')
  assert.equal((await adapter.verify(vm.id, '203.0.113.9')).via, 'slot')
  assert.equal(getVm(root, vm.id).schedule_disabled_reason, 'oauth_revoked')
  assert.equal(getVm(root, vm.id).ip_pool_maintenance.operation_id, 'op-1')
  assert.equal((await adapter.stopOld(capture)).ok, true)
  assert.deepEqual(events.slice(-2), ['stop', 'drained'])
})

test('stopped slot is not silently started or declared verified', async (t) => {
  const { adapter } = fixture(t, { status: 'stopped' })
  await adapter.hold('vm-01', 'op-1')
  assert.equal((await adapter.apply('vm-01', { port: 24100 }, '203.0.113.9')).requires_start, true)
  assert.deepEqual(await adapter.verify('vm-01', '203.0.113.9'), { ok: false, code: 'slot_not_running' })
})

test('changed timezone recreates the container even on the same proxy network', async (t) => {
  const { adapter, events, root } = fixture(t, {
    timezone: 'America/Los_Angeles',
    fingerprint: { timezone: 'America/Los_Angeles' },
  })
  await adapter.hold('vm-01', 'op-tz')
  await adapter.apply('vm-01', { port: 24100 }, '203.0.113.9')
  assert.equal(events.includes('recreate'), true)
  assert.equal(events.includes('reload'), false)
  assert.equal(getVm(root, 'vm-01').fingerprint.timezone, 'America/New_York')
})

test('Claude recreation persists the actual runtime and worker failure retains maintenance', async (t) => {
  const { adapter, root } = fixture(t, { timezone: 'America/Los_Angeles' }, { useDefaultRecreate: true })
  await adapter.hold('vm-01', 'op-tz')
  await adapter.apply('vm-01', { port: 24100 }, '203.0.113.9')
  assert.equal(getVm(root, 'vm-01').runtime.container_id, 'new-container')
  const bad = fixture(t, { timezone: 'America/Los_Angeles' }, { worker: { ok: true, rust_ok: false } })
  await bad.adapter.hold('vm-01', 'op-tz')
  await assert.rejects(bad.adapter.apply('vm-01', { port: 24100 }, '203.0.113.9'), { code: 'slot_reload_failed' })
  assert.equal(getVm(bad.root, 'vm-01').ip_pool_maintenance.operation_id, 'op-tz')
})

test('unknown or mismatching exit geo keeps old timezone and maintenance', async (t) => {
  for (const geo of [
    { ok: false },
    { ok: true, geo: { ip: '203.0.113.10', timezone: 'America/New_York' } },
    { ok: true, geo: { ip: '203.0.113.9', timezone: 'not-a-zone' } },
  ]) {
    const { adapter, root, events } = fixture(t, { timezone: 'America/Los_Angeles' }, { geo })
    await adapter.hold('vm-01', 'op-tz')
    await assert.rejects(adapter.apply('vm-01', { port: 24100 }, '203.0.113.9'), { code: 'TIMEZONE_LOOKUP_FAILED' })
    assert.equal(getVm(root, 'vm-01').timezone, 'America/Los_Angeles')
    assert.equal(getVm(root, 'vm-01').ip_pool_maintenance.operation_id, 'op-tz')
    assert.equal(events.includes('bind'), false)
  }
})

test('runtime timezone mismatch fails apply and later verification without releasing maintenance', async (t) => {
  const { adapter, root } = fixture(t, { timezone: 'America/Los_Angeles' }, { staleRuntime: true })
  await adapter.hold('vm-01', 'op-tz')
  await assert.rejects(adapter.apply('vm-01', { port: 24100 }, '203.0.113.9'), { code: 'TIMEZONE_RUNTIME_FAILED' })
  await assert.rejects(adapter.verify('vm-01', '203.0.113.9'), { code: 'TIMEZONE_RUNTIME_FAILED' })
  assert.equal(getVm(root, 'vm-01').ip_pool_maintenance.operation_id, 'op-tz')
})

test('shared old proxy cannot be stopped and unsupported runtime is explicit', async (t) => {
  const { adapter, rows, root } = fixture(t)
  const capture = await adapter.capture('vm-01')
  rows.old.bound_vm_ids = ['vm-02']
  assert.equal((await adapter.stopOld(capture)).code, 'old_proxy_still_bound')
  patchVmRecord(root, 'vm-01', { node_id: 'remote-1' })
  await assert.rejects(adapter.capture('vm-01'), { code: 'ip_pool_runtime_unsupported' })
})

test('release detaches proxy and removing maintenance does not make master pin usable', async (t) => {
  const { root, adapter } = fixture(t)
  await adapter.hold('vm-01', 'release-1')
  assert.equal((await adapter.detach('vm-01')).ok, true)
  await adapter.restore('vm-01', 'release-1')
  const vm = getVm(root, 'vm-01')
  assert.equal(vm.proxy, null)
  assert.equal(vm.schedule_disabled_reason, 'oauth_revoked')
  const scheduler = Object.create(PoolScheduler.prototype)
  scheduler.projectRoot = root
  assert.deepEqual(await scheduler.checkEligibility({ vm, pinned: true }), { ok: false, reason: 'proxy_required' })
})
