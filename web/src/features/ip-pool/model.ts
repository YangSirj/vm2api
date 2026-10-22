import { ipv4, ipv6 } from 'zod'

export type IpPoolState =
  | 'unassigned'
  | 'applied'
  | 'pending'
  | 'login_locked'
  | 'error'
  | 'released'
  | 'blacklisted'

export type IpPoolAnchor = {
  ip?: string
  exit_ip?: string
  country_code?: string
  country?: string
  region?: string
  city?: string
  latitude?: number
  longitude?: number
}

export type IpPoolView = {
  configured: boolean
  vm_id: string
  state: IpPoolState
  assignment?: {
    assignment_id: string
    version: number
    state: string
    current_exit_ip: string
    anchor?: IpPoolAnchor | string | null
    distance_km_from_anchor?: number | null
    consumer_ref?: string
  } | null
  applied?: {
    exit_ip?: string
    verified_at?: string
    assignment_version?: number
    proxy_id?: string
  } | null
  login_locked?: boolean
  error?: { code: string; message: string } | null
  blacklist?: {
    blacklist_id: string
    deletion_state: 'pending' | 'succeeded' | 'failed' | 'unverified'
    retryable: boolean
    endpoint_access_revoked?: boolean
    deleted_at?: string | null
    last_sync_error?: string | null
  } | null
  operation?: {
    id: string
    type: string
    phase: string
    started_at?: string
  } | null
}

export type IpPoolAction =
  | 'assign'
  | 'apply'
  | 'replace'
  | 'probe'
  | 'release'
  | 'login-lock'
  | 'login-unlock'
  | 'blacklist'
  | 'retry-deletion'

export const stateLabels: Record<IpPoolState, string> = {
  unassigned: '未分配',
  applied: '已应用',
  pending: '等待完成',
  login_locked: '登录期间已锁定',
  error: '需要处理',
  released: '已释放',
  blacklisted: '已标黑',
}

export function poolManaged(view: IpPoolView): boolean {
  return Boolean(
    view.operation ||
    view.login_locked ||
    !['unassigned', 'released'].includes(view.state) ||
    (view.assignment && view.state !== 'released')
  )
}

export function assignmentApplied(view: IpPoolView): boolean {
  return Boolean(
    view.assignment?.current_exit_ip &&
    view.applied?.verified_at &&
    view.applied.exit_ip === view.assignment.current_exit_ip &&
    view.applied.assignment_version === view.assignment.version
  )
}

/** 分配目标与历史探测分开，释放/标黑后不把旧出口当作当前出口。 */
export function poolExitSummary(view: IpPoolView | undefined) {
  const history = view?.applied?.exit_ip
    ? `历史核验出口 ${view.applied.exit_ip}${view.applied.verified_at ? `（${view.applied.verified_at}）` : ''}`
    : '没有出口核验记录'
  const current =
    view?.assignment &&
    !['released', 'blacklisted', 'unassigned'].includes(view.state) &&
    !['released', 'blacklisted'].includes(view.assignment.state)
      ? view.assignment.current_exit_ip
      : ''
  if (current && view) {
    const verified =
      !view.error &&
      ['applied', 'login_locked'].includes(view.state) &&
      assignmentApplied(view)
    return {
      label: verified ? '出口' : '分配出口',
      value: current,
      title: verified
        ? `已核验出口 ${current}（${view.applied?.verified_at}）；显示已有记录，未实时探测`
        : `当前分配 ${current}，尚未核验为当前出口；${history}`,
    }
  }
  const value =
    view?.state === 'released'
      ? '已释放'
      : view?.state === 'blacklisted'
        ? '已标黑'
        : view?.configured && view.state === 'unassigned'
          ? '未分配'
          : '未知'
  return { label: '出口', value, title: `${value}；${history}` }
}

export function poolActions(view: IpPoolView) {
  const locked = view.login_locked || view.state === 'login_locked'
  const active = Boolean(
    view.assignment &&
    !['released', 'blacklisted', 'unassigned'].includes(view.state)
  )
  const ready = view.state === 'applied' && assignmentApplied(view)
  return {
    assign:
      view.configured &&
      (['unassigned', 'released'].includes(view.state) ||
        (view.state === 'error' &&
          view.error?.code === 'ASSIGNMENT_MISSING' &&
          !view.assignment)) &&
      !locked,
    apply:
      view.configured &&
      !locked &&
      !view.blacklist &&
      ['pending', 'error'].includes(view.state),
    replace: active && !locked && ready,
    probe:
      active &&
      !view.error &&
      Boolean(view.applied?.exit_ip) &&
      ['applied', 'login_locked'].includes(view.state),
    access:
      active && !view.error && assignmentApplied(view) && (ready || locked),
    release: active && !locked,
    'login-lock': active && ready && !locked,
    'login-unlock': Boolean(locked) && view.state !== 'blacklisted',
    blacklist: active,
    'retry-deletion': Boolean(
      (view.blacklist?.retryable &&
        view.blacklist.deletion_state !== 'succeeded') ||
      (view.state === 'blacklisted' && !view.blacklist)
    ),
  }
}

export function poolOperationBusy(view: IpPoolView) {
  return Boolean(
    view.operation &&
    [
      'running',
      'draining',
      'applying',
      'probing',
      'settling',
      'queued',
    ].includes(view.operation.phase)
  )
}

/** 指定出口沿用普通分配/换绑的权限，不绕过登录锁或未决操作。 */
export function poolTargetAction(
  view: IpPoolView
): 'assign' | 'replace' | null {
  if (poolOperationBusy(view)) return null
  const actions = poolActions(view)
  if (actions.assign) return 'assign'
  if (actions.replace) return 'replace'
  return null
}

const targetIpv4 = ipv4()
const targetIpv6 = ipv6()

export function normalizeTargetExitIp(value: string): string | null {
  const ip = value.trim()
  if (targetIpv4.safeParse(ip).success) return ip
  if (targetIpv6.safeParse(ip).success)
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1)
  return null
}

export function formatAnchor(anchor: IpPoolAnchor | string | null | undefined) {
  if (!anchor) return '未知'
  if (typeof anchor === 'string') return anchor || '未知'
  return (
    [
      anchor.ip || anchor.exit_ip,
      anchor.country || anchor.country_code,
      anchor.region,
      anchor.city,
    ]
      .filter(Boolean)
      .join(' · ') || '未知'
  )
}

export function formatDistance(distance: number | null | undefined) {
  if (distance == null || !Number.isFinite(distance) || distance < 0)
    return '未知'
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(distance)} 公里`
}

export function deletionLabel(blacklist: NonNullable<IpPoolView['blacklist']>) {
  if (blacklist.deletion_state === 'succeeded') return '上游已确认删除'
  if (blacklist.deletion_state === 'failed') return '已标黑，删除失败'
  if (blacklist.deletion_state === 'unverified') return '已标黑，删除结果未核对'
  return '已标黑，等待上游删除'
}

export function localDateTime(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
}

export function incidentTime(value: string, now = Date.now()): string | null {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || ms > now) return null
  return new Date(ms).toISOString()
}
