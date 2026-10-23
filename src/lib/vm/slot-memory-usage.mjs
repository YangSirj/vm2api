/** Read-only Docker cgroup usage, shared by panel list/detail polling. */
import { dockerJson } from '../cluster/docker-remote.mjs'
import { slotHost } from './slot-host.mjs'
import { containerName } from './vm-runtime.mjs'

const bytes = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null)

export function memoryUsageSnapshot(inspect, stats, sampledAt) {
  const limit = bytes(inspect?.HostConfig?.Memory)
  if (inspect?.State?.Running === false) {
    return { status: 'stopped', used_bytes: null, limit_bytes: limit, sampled_at: sampledAt }
  }
  const used = bytes(stats?.memory_stats?.usage)
  if (inspect?.State?.Running !== true || used == null || limit == null) {
    return { status: 'unavailable', used_bytes: null, limit_bytes: null, sampled_at: sampledAt }
  }
  return { status: 'ok', used_bytes: used, limit_bytes: limit, sampled_at: sampledAt }
}

export function createSlotMemoryCollector({
  hostFor = slotHost,
  request = dockerJson,
  now = Date.now,
  cacheMs = 10_000,
} = {}) {
  const cache = new Map()
  return async function collect(vms) {
    const result = new Map()
    await Promise.all(
      vms.map(async (vm) => {
        const key = `${vm.node_id || 'local'}:${vm.id}`
        let entry = cache.get(key)
        if (!entry || now() - entry.at >= cacheMs) {
          entry = { at: now(), pending: null }
          entry.pending = (async () => {
            try {
              const host = hostFor(vm)
              if (host.native)
                return {
                  status: 'unsupported',
                  used_bytes: null,
                  limit_bytes: null,
                  sampled_at: new Date(now()).toISOString(),
                }
              const connect = host.dockerApi()
              const path = `/containers/${encodeURIComponent(containerName(vm.id))}`
              const inspect = await request(connect, { path: `${path}/json`, timeoutMs: 3000 })
              const stats = inspect?.State?.Running
                ? await request(connect, { path: `${path}/stats?stream=false&one-shot=true`, timeoutMs: 3000 })
                : null
              return memoryUsageSnapshot(inspect, stats, new Date(now()).toISOString())
            } catch {
              return {
                status: 'unavailable',
                used_bytes: null,
                limit_bytes: null,
                sampled_at: new Date(now()).toISOString(),
              }
            }
          })()
          cache.set(key, entry)
        }
        result.set(vm.id, await entry.pending)
      }),
    )
    // Evict old entries without discarding other callers' recently sampled VMs.
    for (const [key, entry] of cache) if (now() - entry.at > 60_000) cache.delete(key)
    return result
  }
}

export const collectSlotMemory = createSlotMemoryCollector()
