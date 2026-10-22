import path from 'node:path'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  getVm,
  patchVmRecord,
  bindVmProxy,
  waitForSlotDrain,
  persistVmTimezone,
  persistVmRuntime,
} from '../vm/vm-registry.mjs'
import { withVmLock, isValidVmId } from '../vm/vm-file.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { isKvmRuntime } from '../vm/runtime-kind.mjs'
import { inspectContainer } from '../vm/vm-runtime.mjs'
import { slotExecArgv, slotExecContainer } from '../vm/slot-exec.mjs'
import { reloadSlotReady, startSlotReady } from '../vm/slot-runtime.mjs'
import { validTimezone } from '../core/timezone.mjs'
import { ensureProxyEgress, stopProxyEgress, drainEgressForProxyConfig, isLocalEgressProxy } from '../vm/egress.mjs'
import { boundVmIdsOf } from '../vm/proxy-pool.mjs'

const exec = promisify(execFile)
const failure = (code) => Object.assign(new Error(code), { code })

async function readSlotTimezone(vm) {
  const { stdout } = await exec('docker', slotExecArgv(vm, ['printenv', 'TZ']), {
    timeout: 10000,
    maxBuffer: 4096,
  })
  return validTimezone(String(stdout || '').trim())
}

async function probeSlotExit(vm) {
  try {
    const { stdout } = await exec(
      'docker',
      slotExecArgv(vm, [
        'curl',
        '--fail',
        '--silent',
        '--show-error',
        '--noproxy',
        '*',
        '-4',
        '--max-time',
        '15',
        'https://api.ipify.org',
      ]),
      { timeout: 20000, maxBuffer: 4096 },
    )
    const ip = String(stdout || '').trim()
    return net.isIP(ip) ? { ok: true, exit_ip: ip } : { ok: false, code: 'slot_exit_invalid' }
  } catch {
    return { ok: false, code: 'slot_exit_probe_failed' }
  }
}

/** The integration owns only ip_pool_maintenance. Existing account holds remain untouched. */
export function createVmAdapter({
  projectRoot,
  proxyPool,
  getScheduler,
  getMonitors,
  routingConfig = {},
  ops = {},
} = {}) {
  const read = ops.getVm || ((id) => getVm(projectRoot, id))
  const patch = ops.patchVm || ((id, fn) => patchVmRecord(projectRoot, id, fn))
  const inspect = ops.inspect || ((vm) => inspectContainer(slotExecContainer(vm)))
  const ensure = ops.ensureProxyEgress || ((proxy) => ensureProxyEgress(projectRoot, proxy))
  const reload =
    ops.reload ||
    ((vm) =>
      reloadSlotReady(vm, projectRoot, {
        routing: typeof routingConfig === 'function' ? routingConfig() : routingConfig,
      }))
  const bind = ops.bindVmProxy || ((id, proxy) => bindVmProxy(projectRoot, id, proxy))
  const probe = ops.probeSlotExit || probeSlotExit
  const readTimezone = ops.readTimezone || readSlotTimezone
  const recreate =
    ops.recreate ||
    (async (vm) => {
      const result = await (ops.startSlotReady || startSlotReady)(vm, projectRoot, {
        recreate: true,
        routing: typeof routingConfig === 'function' ? routingConfig() : routingConfig,
      })
      const runtime = result?.runtime || result?.docker?.runtime
      if (result?.ok && runtime) persistVmRuntime(projectRoot, vm.id, runtime)
      return result
    })

  async function runtimeTimezone(vm) {
    try {
      return await readTimezone(vm)
    } catch {
      throw failure('TIMEZONE_RUNTIME_FAILED')
    }
  }

  function requireVm(id) {
    if (!isValidVmId(id)) throw failure('invalid_vm_id')
    const vm = read(id)
    if (!vm) throw failure('vm_not_found')
    if (
      (ops.platform || process.platform) !== 'linux' ||
      vm.node_id ||
      isKvmRuntime(vm) ||
      isCodexVm(vm) ||
      (vm.runtime?.type && vm.runtime.type !== 'docker')
    )
      throw failure('ip_pool_runtime_unsupported')
    return vm
  }

  function maintained(id) {
    const vm = requireVm(id)
    if (!vm.ip_pool_maintenance?.operation_id) throw failure('ip_pool_maintenance_required')
    return vm
  }

  return {
    async capture(vmId) {
      const vm = requireVm(vmId)
      const state = await inspect(vm)
      return {
        vmId,
        proxy: vm.proxy ? { ...vm.proxy } : null,
        running: state?.running === true,
        status: vm.status || null,
        owner_user_id: vm.owner_user_id || null,
      }
    },
    hold(vmId, operationId) {
      if (!operationId || typeof operationId !== 'string') throw failure('operation_id_required')
      return withVmLock(path.join(projectRoot, 'vms', `${vmId}.json`), () => {
        const vm = requireVm(vmId)
        const current = vm.ip_pool_maintenance?.operation_id
        if (current && current !== operationId) throw failure('ip_pool_operation_busy')
        if (!current)
          patch(vmId, (latest) => {
            latest.ip_pool_maintenance = { operation_id: operationId, since: new Date().toISOString() }
            return latest
          })
        return { ok: true, operation_id: operationId }
      })
    },
    async drain(vmId, { timeoutMs = 120000 } = {}) {
      maintained(vmId)
      const scheduler = getScheduler?.()
      if (!scheduler?.vmInflight) throw failure('ip_pool_scheduler_unavailable')
      const deadline = Date.now() + timeoutMs
      const models = await (ops.waitForSlotDrain || waitForSlotDrain)(scheduler, [vmId], { timeoutMs })
      if (!models.ok) return models
      const count = () =>
        (getMonitors?.() || []).reduce((sum, monitor) => sum + (monitor?.inflightForVm?.(vmId) || 0), 0)
      let background = count()
      while (background > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        background = count()
      }
      return background ? { ok: false, inflight: 0, background_inflight: background } : models
    },
    async apply(vmId, bridge, expectedExitIp) {
      const vm = maintained(vmId)
      if (!net.isIP(String(expectedExitIp || ''))) throw failure('expected_exit_ip_required')
      const port = Number(bridge?.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure('invalid_bridge_port')
      const created = proxyPool.ensureSocks(
        { host: '127.0.0.1', port },
        {
          ownerUserId: vm.owner_user_id || null,
          label: `IP pool ${vmId}`,
        },
      )
      if (!created.ok) throw failure(created.error || 'proxy_import_failed')
      const egress = await ensure(created.proxy)
      if (!egress?.ok) throw failure('proxy_egress_failed')
      // The SOCKS server address may be a relay, so query the allocated public exit explicitly.
      const detected = await proxyPool.detectGeo(created.proxy.id, { force: true, expectedIp: expectedExitIp })
      const timezone = validTimezone(detected?.geo?.timezone)
      if (!detected?.ok || detected.geo?.ip !== expectedExitIp || !timezone) throw failure('TIMEZONE_LOOKUP_FAILED')
      const runtime = await inspect(vm)
      const previousTimezone = runtime?.running ? await runtimeTimezone(vm) : null
      const binding = proxyPool.bind(created.proxy.id, vmId)
      if (!binding.ok) throw failure(binding.error || 'proxy_bind_failed')
      bind(vmId, proxyPool.getProxyForVm(vmId))
      if (!persistVmTimezone(projectRoot, vmId, timezone, { source: 'proxy_geo' }))
        throw failure('TIMEZONE_RUNTIME_FAILED')
      if (!runtime?.running)
        return { ok: true, proxy_id: created.proxy.id, timezone, requires_start: true, worker: null }
      // Restarting a container keeps its old TZ environment. Recreate when the zone changed.
      const worker = await (previousTimezone === timezone ? reload : recreate)(read(vmId))
      if (!worker?.ok || worker.rust_ok === false) throw failure('slot_reload_failed')
      if ((await runtimeTimezone(read(vmId))) !== timezone) throw failure('TIMEZONE_RUNTIME_FAILED')
      return { ok: true, proxy_id: created.proxy.id, timezone, worker: { ok: true }, requires_start: false }
    },
    async verify(vmId, expectedExitIp) {
      const vm = maintained(vmId)
      if (!net.isIP(String(expectedExitIp || ''))) throw failure('expected_exit_ip_required')
      if (!(await inspect(vm))?.running) return { ok: false, code: 'slot_not_running' }
      const timezone = validTimezone(vm.timezone)
      if (
        !timezone ||
        (vm.fingerprint && vm.fingerprint.timezone !== timezone) ||
        (await runtimeTimezone(vm)) !== timezone
      )
        throw failure('TIMEZONE_RUNTIME_FAILED')
      const result = await probe(vm)
      if (!result?.ok) return { ok: false, code: result?.code || 'slot_exit_probe_failed' }
      if (result.exit_ip !== expectedExitIp)
        return { ok: false, code: 'exit_ip_mismatch', exit_ip: result.exit_ip, expected_exit_ip: expectedExitIp }
      return { ok: true, exit_ip: result.exit_ip, verified_at: new Date().toISOString(), via: 'slot' }
    },
    restore(vmId, operationId) {
      return withVmLock(path.join(projectRoot, 'vms', `${vmId}.json`), () => {
        const vm = requireVm(vmId)
        if (vm.ip_pool_maintenance?.operation_id !== operationId)
          return { ok: false, code: 'ip_pool_operation_mismatch' }
        patch(vmId, (latest) => {
          delete latest.ip_pool_maintenance
          return latest
        })
        return { ok: true }
      })
    },
    async rollback(vmId, snapshot) {
      maintained(vmId)
      if (snapshot?.vmId !== vmId) throw failure('vm_snapshot_mismatch')
      if (snapshot.proxy?.id) {
        const old = proxyPool.getProxyByIdWithAuth(snapshot.proxy.id)
        if (!old) return { ok: false, code: 'old_proxy_missing' }
        const egress = await ensure(old)
        if (!egress?.ok) return { ok: false, code: 'old_proxy_egress_failed' }
        const rebound = proxyPool.bind(old.id, vmId)
        if (!rebound.ok) return { ok: false, code: rebound.error || 'old_proxy_bind_failed' }
        bind(vmId, old)
      } else {
        proxyPool.unbindVm(vmId)
        bind(vmId, null)
      }
      if (snapshot.running && snapshot.proxy) {
        const result = await reload(read(vmId))
        if (!result?.ok) return { ok: false, code: 'old_slot_reload_failed' }
      }
      return { ok: true }
    },
    async detach(vmId) {
      const vm = maintained(vmId)
      const previous = vm.proxy ? { ...vm.proxy } : null
      proxyPool.unbindVm(vmId)
      bind(vmId, null)
      if (!previous?.id || isLocalEgressProxy(previous)) return { ok: true }
      const old = proxyPool.getProxyByIdWithAuth(previous.id)
      if (old && boundVmIdsOf(old).length) return { ok: true, shared: true }
      const stopped = await (ops.stopProxyEgress || ((proxyId) => stopProxyEgress(projectRoot, proxyId)))(previous.id)
      if (!stopped?.ok) return { ok: false, code: 'old_egress_stop_failed' }
      const drained = await (ops.drainEgress || ((proxyId) => drainEgressForProxyConfig(projectRoot, proxyId)))(
        previous.id,
      )
      return drained?.ok ? { ok: true } : { ok: false, code: 'old_egress_drain_failed' }
    },
    async stopOld(snapshot) {
      const id = snapshot?.proxy?.id
      if (!id || isLocalEgressProxy(snapshot.proxy)) return { ok: true, skipped: true }
      const old = proxyPool.getProxyByIdWithAuth(id)
      if (old && boundVmIdsOf(old).length) return { ok: false, code: 'old_proxy_still_bound' }
      const stopped = await (ops.stopProxyEgress || ((proxyId) => stopProxyEgress(projectRoot, proxyId)))(id)
      if (!stopped?.ok) return { ok: false, code: 'old_egress_stop_failed' }
      const drained = await (ops.drainEgress || ((proxyId) => drainEgressForProxyConfig(projectRoot, proxyId)))(id)
      return drained?.ok ? { ok: true, proxy_id: id } : { ok: false, code: 'old_egress_drain_failed' }
    },
  }
}
