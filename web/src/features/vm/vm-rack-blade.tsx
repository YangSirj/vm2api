import {
  memo,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import { Download, Link2, RefreshCw } from 'lucide-react'
import { credEndpointLabel, credEndpointOf } from '@/lib/cred-type'
import { fmtAgo, fmtNum, fmtUsd } from '@/lib/format'
import { tierVisual } from '@/lib/tier-visual'
import { cn } from '@/lib/utils'
import { slotCredentialLabel } from '@/lib/vm-kind'
import {
  claudeTier,
  credentialStatus,
  poolStatus,
  restrictionCopy,
  seatTitle,
  vmFailedAt,
} from '@/lib/vm-status'
import { vmTotalCost, vmTotalTokens } from '@/lib/vm-usage'
import { SeatCells } from '@/components/scheduler-viz'
import { StatusMark } from '@/components/status-mark'
import { ProxyChip } from '@/features/proxies/proxy-chip'
import { runtimeTypeLabel, runtimeTypeOf } from '@/features/vm/machine-spec'
import {
  SchedulableSwitch,
  vmSchedulableProps,
} from '@/features/vm/schedulable-switch'
import {
  VmCostLedger,
  VmQuotaActions,
  VmUsageWindows,
} from '@/features/vm/usage-windows'
import { VmActionMenu } from '@/features/vm/vm-action-menu'
import { useVmActions } from '@/features/vm/vm-actions-context'
import { VmIpPoolSummary } from '@/features/vm/vm-ip-pool-summary'
import { VmMemoryUsage } from '@/features/vm/vm-memory-usage'
import { useVmPerms } from '@/features/vm/vm-perms'
import {
  bladeState,
  zoneOf,
  type BladeState,
} from '@/features/vm/vm-rack-model'

export type RackSize = 's' | 'm' | 'l'

const TIER_VARS: Record<string, CSSProperties> = {
  pro: {
    '--tc': 'var(--tier-pro-solid)',
    '--tf': 'var(--tier-pro-fg)',
  } as CSSProperties,
  max: {
    '--tc': 'var(--tier-max-solid)',
    '--tf': 'var(--tier-max-fg)',
  } as CSSProperties,
  codex: {
    '--tc': 'var(--tier-codex-solid)',
    '--tf': 'var(--tier-codex-fg)',
  } as CSSProperties,
}

/** 等级只占左沿一截色标与徽标，不再整卡染色——机架是一块底，等级是标签。 */
export function tierStyle(vm: Vm): CSSProperties | undefined {
  return TIER_VARS[tierVisual(vm).key]
}

export function TierBadge({ vm, className }: { vm: Vm; className?: string }) {
  const skin = tierVisual(vm)
  if (skin.key === 'none') return null
  return (
    <span
      className={cn(
        'inline-flex h-[18px] shrink-0 items-center rounded-[5px] px-1.5 text-[10px] leading-none font-bold tracking-[0.04em] uppercase',
        skin.badge,
        className
      )}
    >
      {claudeTier(vm).label}
    </span>
  )
}

export const BLADE_STATE_CLASS: Record<BladeState, string> = {
  live: 'bg-muted/50',
  unprobed: 'bg-muted/50',
  dead: 'bg-[color:color-mix(in_oklch,var(--status-bad-bg)_35%,var(--card))]',
  vacant: 'bg-transparent shadow-[inset_0_0_0_1px_var(--border)]',
}

export function useOpenOnKey(vm: Vm) {
  const actions = useVmActions()
  return {
    onClick: () => actions.openDetail(vm),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      actions.openDetail(vm)
    },
  }
}

/** 底栏右侧：调度开关 + 扩展菜单。点击不冒泡到卡片。 */
export function BladeControls({
  vm,
  className,
}: {
  vm: Vm
  className?: string
}) {
  return (
    <div
      className={cn('ms-auto flex items-center gap-0.5', className)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <SchedulableSwitch {...vmSchedulableProps(vm)} />
      <VmActionMenu vm={vm} />
    </div>
  )
}

/** 席位与详情使用同一套方格，运行、排队和空余读数放在第二排。 */
export function VmSeats({
  vm,
  compact = false,
}: {
  vm: Vm
  compact?: boolean
}) {
  if (vm.seats_max == null) return null
  const used = Number(vm.seats_used) || 0
  const max = Number(vm.seats_max) || 0
  const grace = Math.min(used, Number(vm.seats_grace) || 0)
  const queued = Number(vm.queue_depth) || 0
  const running = Number(vm.inflight) || 0
  const free = Math.max(0, max - used)
  return (
    <div
      className='min-w-0 space-y-1 text-[10.5px] text-muted-foreground tabular-nums'
      title={`${seatTitle(vm)} · 运行 ${running} 个请求 · 空余 ${free} 席。实心为占用、浅色为宽限保留、灰色为空闲；同一席位可承载多个请求。`}
    >
      <div className='flex min-w-0 items-center justify-between gap-2'>
        <span className='shrink-0'>席位</span>
        <div
          className={cn('max-w-[127px] min-w-0', compact && 'max-w-[107px]')}
        >
          <SeatCells
            used={used}
            grace={grace}
            max={max}
            size={compact ? 'sm' : 'md'}
            className='justify-end'
          />
        </div>
      </div>
      <div className='flex justify-end gap-x-2 whitespace-nowrap'>
        <span className={running ? 'text-primary' : undefined}>
          运行 {running}
        </span>
        <span
          className={queued ? 'text-[color:var(--status-warn)]' : undefined}
        >
          排队 {queued}
        </span>
        <span>空余 {free}</span>
      </div>
    </div>
  )
}

/** 一行规格：调用形式 · 形态 · 节点 · 出口。替代原先五枚边框 chip。 */
function SpecLine({ vm }: { vm: Vm }) {
  const lane = credEndpointOf(vm)
  const parts = [
    lane === 'none' ? null : credEndpointLabel(lane),
    runtimeTypeLabel(runtimeTypeOf(vm)),
    vm.node_name || vm.node_id || 'local',
  ].filter(Boolean)
  return (
    <div className='flex min-w-0 items-center gap-1.5 overflow-hidden text-[11.5px] whitespace-nowrap text-muted-foreground'>
      {parts.map((p, i) => (
        <span key={i} className='flex shrink-0 items-center gap-1.5'>
          {p}
          <span
            aria-hidden='true'
            className='text-[color:var(--text-tertiary)]'
          >
            ·
          </span>
        </span>
      ))}
      <ProxyChip vm={vm} className='min-w-0 shrink' />
    </div>
  )
}

function Callout({
  tone,
  title,
  children,
  action,
}: {
  tone: 'bad' | 'caution' | 'none'
  title: ReactNode
  children?: ReactNode
  action: ReactNode
}) {
  return (
    <div
      className={cn(
        'grid min-w-0 content-center gap-1.5 rounded-lg px-3.5 py-3 text-[12.5px]',
        tone === 'bad' &&
          'bg-[color:var(--status-bad-bg)] text-[color:var(--status-bad)]',
        tone === 'caution' &&
          'bg-[color:var(--status-caution-bg)] text-[color:var(--status-caution)]',
        tone === 'none' &&
          'border border-dashed border-border text-muted-foreground'
      )}
    >
      <b className='font-semibold'>{title}</b>
      {children}
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {action}
      </div>
    </div>
  )
}

function CalloutAction({
  icon,
  children,
  onClick,
}: {
  icon: ReactNode
  children: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      className='inline-flex h-[26px] items-center gap-1.5 rounded-md border border-current px-2.5 text-xs transition-colors hover:bg-[color:color-mix(in_oklch,currentColor_12%,transparent)] [&_svg]:size-3'
    >
      {icon}
      {children}
    </button>
  )
}

function lifeLine(vm: Vm, accounts?: UsageAccountRow[]) {
  const cost = vmTotalCost(vm, accounts)
  if (!cost) return null
  return (
    <span className='font-mono text-[11.5px] text-muted-foreground tabular-nums'>
      总计 {fmtUsd(cost, 2)} · {fmtNum(vmTotalTokens(vm, accounts))} tok
    </span>
  )
}

export function BladeCallout({
  vm,
  accounts,
  state,
}: {
  vm: Vm
  accounts?: UsageAccountRow[]
  state: BladeState
}) {
  const actions = useVmActions()
  const canCred = useVmPerms().credential
  if (state === 'dead') {
    const failed = vmFailedAt(vm)
    const ago = failed ? fmtAgo(new Date(failed).toISOString()) : ''
    return (
      <Callout
        tone='bad'
        title={`${credentialStatus(vm).text || '无效凭证'}${ago ? ` · ${ago}` : ''}`}
        action={
          canCred ? (
            <CalloutAction
              icon={<Link2 />}
              onClick={() => actions.openReauth(vm)}
            >
              重新授权
            </CalloutAction>
          ) : null
        }
      >
        {vm.refresh_error ? (
          <span className='truncate font-mono text-[11.5px] opacity-90'>
            {String(vm.refresh_error)}
          </span>
        ) : null}
        {lifeLine(vm, accounts)}
      </Callout>
    )
  }
  if (state === 'vacant') {
    return (
      <Callout
        tone='none'
        title='未绑定账号'
        action={
          canCred ? (
            <CalloutAction
              icon={<Download />}
              onClick={() => actions.openReauth(vm)}
            >
              绑定凭证
            </CalloutAction>
          ) : null
        }
      >
        <span>绑定后进入探测，再按结果入池。</span>
      </Callout>
    )
  }
  return (
    <Callout
      tone='caution'
      title='额度未探测'
      action={
        canCred ? (
          <CalloutAction
            icon={<RefreshCw />}
            onClick={() => actions.refreshToken(vm)}
          >
            刷新并探测
          </CalloutAction>
        ) : null
      }
    >
      <span>未探测的槽不计入可用余量。</span>
      {lifeLine(vm, accounts)}
    </Callout>
  )
}

/**
 * 读数：额度窗口与成本账，和列表、弹窗同一套组件。卡够宽时左右并排，
 * 5H / 7D 逐行对齐；窄卡上下叠放。重置 / 查询按钮放在读数下方，不挤底栏。
 */
function BladeUsage({
  vm,
  accounts,
  now,
}: {
  vm: Vm
  accounts?: UsageAccountRow[]
  now: number
}) {
  return (
    <div className='@container grid min-w-0 content-start gap-1.5'>
      <div className='grid min-w-0 gap-x-3 gap-y-2 @min-[24rem]:grid-cols-[minmax(0,1fr)_auto]'>
        <VmUsageWindows vm={vm} now={now} quiet />
        <VmCostLedger
          vm={vm}
          accounts={accounts}
          className='border-t border-[color:var(--hairline)] pt-2 @min-[24rem]:border-s @min-[24rem]:border-t-0 @min-[24rem]:ps-3 @min-[24rem]:pt-0'
        />
      </div>
      <QuotaRow vm={vm} now={now} />
    </div>
  )
}

function QuotaRow({ vm, now }: { vm: Vm; now: number }) {
  return (
    <div
      className='-ms-1.5'
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <VmQuotaActions vm={vm} now={now} />
    </div>
  )
}

export const VmBlade = memo(function VmBlade({
  vm,
  accounts,
  size,
  now,
}: {
  vm: Vm
  accounts?: UsageAccountRow[]
  size: Exclude<RackSize, 's'>
  now: number
}) {
  const open = useOpenOnKey(vm)
  const state = bladeState(vm)
  const large = size === 'l'
  const email = String(vm.email || '')
  const restricted = zoneOf(vm) === 'restricted'
  return (
    <article
      role='button'
      tabIndex={0}
      aria-label={`查看 ${vm.id} 详情`}
      style={tierStyle(vm)}
      className={cn(
        'relative grid min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_1fr_auto] rounded-[10px] shadow-[inset_0_0_0_1px_var(--hairline)] transition-[background-color,box-shadow] duration-150 ease-out hover:bg-muted hover:shadow-[inset_0_0_0_1px_var(--border)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        "before:absolute before:top-3 before:left-0 before:h-[18px] before:w-[3px] before:rounded-r-[2px] before:bg-[color:var(--tc,transparent)] before:content-['']",
        large
          ? 'gap-2.5 px-3 ps-3.5 pt-3 pb-2'
          : 'gap-2 px-2.5 ps-3 pt-2.5 pb-1.5',
        BLADE_STATE_CLASS[state],
        zoneOf(vm) === 'off' && 'opacity-80'
      )}
      {...open}
    >
      <div className='grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5'>
        <span className='flex min-w-0 items-baseline gap-2'>
          <span className='font-mono text-[11.5px] text-muted-foreground'>
            {vm.id}
          </span>
          {vm.name && vm.name !== vm.id ? (
            <span className='truncate text-[11.5px] text-[color:var(--text-tertiary)]'>
              {vm.name}
            </span>
          ) : null}
        </span>
        <TierBadge vm={vm} />
        <span
          title={email || undefined}
          className={cn(
            'col-span-2 truncate font-semibold tracking-[-0.012em]',
            large ? 'text-sm' : 'text-[13px]',
            email
              ? state === 'dead'
                ? 'text-muted-foreground'
                : ''
              : 'font-medium text-muted-foreground'
          )}
        >
          {slotCredentialLabel(vm)}
        </span>
        {restricted && state !== 'dead' ? (
          <StatusMark
            variant='pill'
            className='col-span-2 justify-self-start'
            tone={{
              ...poolStatus(vm),
              label: restrictionCopy(vm) || poolStatus(vm).text,
            }}
          />
        ) : null}
      </div>
      <div className='grid min-w-0 grid-cols-2 items-start gap-3'>
        <div className='min-w-0 space-y-1'>
          <SpecLine vm={vm} />
          <VmIpPoolSummary vmId={vm.id} />
        </div>
        <div className='min-w-0 space-y-2'>
          <VmMemoryUsage vm={vm} />
          <VmSeats vm={vm} />
        </div>
      </div>
      {state === 'live' ? (
        <BladeUsage vm={vm} accounts={accounts} now={now} />
      ) : state === 'unprobed' ? (
        <div className='grid min-w-0 content-start gap-1.5'>
          <BladeCallout vm={vm} accounts={accounts} state={state} />
          <QuotaRow vm={vm} now={now} />
        </div>
      ) : (
        <BladeCallout vm={vm} accounts={accounts} state={state} />
      )}
      <div className='hairline-t flex min-h-9 min-w-0 items-center gap-2 pt-1.5 text-[11.5px] text-muted-foreground'>
        <BladeControls vm={vm} />
      </div>
    </article>
  )
})
