import { api, isApiError } from '@/lib/api'
import type { IpPoolAction, IpPoolView } from './model'

export function poolPath(vmId: string) {
  return `/api/panel/ip-pool/vms/${encodeURIComponent(vmId)}`
}

export function poolQueryKey(vmId: string) {
  return ['panel', 'ip-pool', vmId] as const
}

export async function readPool(vmId: string, signal?: AbortSignal) {
  try {
    return await api<IpPoolView>(poolPath(vmId), { signal })
  } catch (error) {
    // Older upstream versions do not have the optional integration endpoint.
    if (isApiError(error) && error.status === 404) {
      return {
        configured: false,
        vm_id: vmId,
        state: 'unassigned',
      } satisfies IpPoolView
    }
    throw error
  }
}

export function poolAction(
  vmId: string,
  action: IpPoolAction,
  body?: Record<string, unknown>
) {
  return api<IpPoolView>(`${poolPath(vmId)}/${action}`, {
    method: 'POST',
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

export async function copyPoolAccess(vmId: string) {
  const access = await api<{ uri: string; expected_exit_ip: string }>(
    `${poolPath(vmId)}/access`,
    {
      method: 'POST',
    }
  )
  if (!access.uri?.startsWith('vless://'))
    throw new Error('没有可复制的 VLESS 链接')
  // Access credentials deliberately stay out of query caches, component state and storage.
  await navigator.clipboard.writeText(access.uri)
  return access.expected_exit_ip
}
