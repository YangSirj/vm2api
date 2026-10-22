import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { poolQueryKey, readPool } from '@/features/ip-pool/api'
import { poolExitSummary } from '@/features/ip-pool/model'
import { useVmPerms } from '@/features/vm/vm-perms'

/** 只读取已有分配和核验记录；显示卡片不会触发出口探测。 */
export function VmIpPoolSummary({
  vmId,
  className,
}: {
  vmId: string
  className?: string
}) {
  const { admin } = useVmPerms()
  const q = useQuery({
    queryKey: poolQueryKey(vmId),
    queryFn: ({ signal }) => readPool(vmId, signal),
    enabled: admin,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  })
  if (!admin) return null
  const summary = poolExitSummary(q.isError ? undefined : q.data)
  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground',
        className
      )}
    >
      <span
        className='min-w-0 truncate'
        title={q.isError ? 'IP 池状态读取失败，出口未知' : summary.title}
      >
        {summary.label}{' '}
        <span className='font-mono tabular-nums'>{summary.value}</span>
      </span>
      <Link
        to='/vm/$id'
        params={{ id: vmId }}
        search={{ tab: 'proxy' }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className='shrink-0 font-medium text-primary underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
        aria-label={`管理 ${vmId} 的 IP`}
      >
        IP 管理
      </Link>
    </div>
  )
}
