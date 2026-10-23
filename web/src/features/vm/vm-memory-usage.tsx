import type { Vm } from '@/types/panel-vm'
import { cn } from '@/lib/utils'

function memoryLabel(bytes: number) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GiB`
    : `${Math.round(bytes / 1024 ** 2)} MiB`
}

export function VmMemoryUsage({ vm }: { vm: Vm }) {
  const memory = vm.memory_usage
  const limit = memory?.limit_bytes
  const label =
    memory?.status === 'ok' && memory.used_bytes != null
      ? `${memoryLabel(memory.used_bytes)} / ${limit == null ? '未知' : limit === 0 ? '不限' : memoryLabel(limit)}`
      : memory?.status === 'stopped'
        ? '已停止'
        : memory?.status === 'unsupported'
          ? '暂不支持'
          : '未知'
  const high =
    memory?.status === 'ok' &&
    limit != null &&
    limit > 0 &&
    (memory.used_bytes ?? 0) / limit >= 0.85
  const percent =
    memory?.status === 'ok' &&
    memory.used_bytes != null &&
    limit != null &&
    limit > 0
      ? Math.max(0, Math.min(100, (memory.used_bytes / limit) * 100))
      : null
  return (
    <div
      className={cn(
        'min-w-0 space-y-1 text-[10.5px] tabular-nums',
        high ? 'text-[color:var(--status-warn)]' : 'text-muted-foreground'
      )}
      title={`容器总内存（包含进程与文件缓存），上限为实际 Docker 限额。${memory?.sampled_at ? `采集时间：${new Date(memory.sampled_at).toLocaleTimeString()}` : ''}`}
    >
      <div className='flex flex-wrap items-baseline justify-between gap-x-1'>
        <span className='shrink-0'>内存</span>
        <span className='text-right'>{label}</span>
      </div>
      <div
        role='progressbar'
        aria-label='虚拟机内存占用'
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent == null ? undefined : Math.round(percent)}
        aria-valuetext={label}
        className='h-1.5 overflow-hidden rounded-full track-recessed'
      >
        {percent == null ? null : (
          <div
            className={cn(
              'h-full rounded-full motion-safe:transition-[width] motion-safe:duration-300',
              high ? 'bg-[color:var(--status-warn-solid)]' : 'bg-primary/70'
            )}
            style={{ width: `${percent}%` }}
          />
        )}
      </div>
    </div>
  )
}
