import type { VmDetailTab } from './vm-perms'

export type VmDetailSearch = { tab?: VmDetailTab }

export function validateVmDetailSearch(
  search: Record<string, unknown>
): VmDetailSearch {
  const tab = search.tab
  return typeof tab === 'string' &&
    ['overview', 'account', 'proxy', 'test', 'ops', 'seed'].includes(tab)
    ? { tab: tab as VmDetailTab }
    : {}
}
