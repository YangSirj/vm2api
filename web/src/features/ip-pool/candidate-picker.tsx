import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { poolCandidatesQueryOptions } from './api'
import {
  candidateLocation,
  candidateMetric,
  filterPoolCandidates,
} from './candidates'
import { formatDistance, normalizeTargetExitIp } from './model'

export function PoolCandidatePicker({
  vmId,
  value,
  currentIp,
  disabled,
  onSelect,
}: {
  vmId: string
  value: string | null
  currentIp: string
  disabled: boolean
  onSelect: (ip: string) => void
}) {
  const [search, setSearch] = useState('')
  const q = useQuery(poolCandidatesQueryOptions(vmId))
  const data = q.data
  const candidates = data?.candidates ?? []
  const filtered = filterPoolCandidates(candidates, search)
  const fetchedAt = data?.fetched_at ? new Date(data.fetched_at) : null
  const normalizedCurrentIp = normalizeTargetExitIp(currentIp)

  return (
    <section className='min-w-0 space-y-2' aria-label='可用公网 IP 列表'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <p className='text-sm font-medium' aria-live='polite'>
          {data
            ? data.complete
              ? `共 ${candidates.length} 个可用 IP`
              : `已加载 ${candidates.length} 个 IP（部分结果）`
            : '可用公网 IP'}
        </p>
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={disabled || q.isFetching}
          onClick={() => void q.refetch()}
        >
          <RefreshCw
            className={q.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'}
          />
          {q.isFetching ? '读取中…' : '刷新列表'}
        </Button>
      </div>
      <div className='space-y-1.5'>
        <Label htmlFor='ip-pool-candidate-search'>搜索 IP 或地区</Label>
        <Input
          id='ip-pool-candidate-search'
          value={search}
          disabled={disabled}
          autoComplete='off'
          placeholder='输入 IP、国家代码、地区或城市'
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {q.isPending ? (
        <p role='status' className='p-3 text-sm text-muted-foreground'>
          正在读取可用 IP…也可以在下方手动输入。
        </p>
      ) : null}
      {q.isError ? (
        <p
          role='alert'
          className='rounded-md bg-destructive/10 p-3 text-sm text-destructive'
        >
          读取候选 IP 失败：{q.error.message}。可刷新重试或手动输入。
          {data ? ' 下方为上次读取的结果。' : ''}
        </p>
      ) : null}
      {data ? (
        <>
          {!data.complete ? (
            <p role='status' className='text-xs text-muted-foreground'>
              结果尚未取全，当前数量不是 IP 池总数。可刷新重试或手动输入其他
              IP。
            </p>
          ) : null}
          <div
            className='max-h-64 overflow-y-auto overscroll-contain rounded-md border'
            aria-label='候选公网 IP'
            aria-busy={q.isFetching}
          >
            {filtered.length ? (
              <ul className='divide-y'>
                {filtered.map((candidate) => {
                  const ip = normalizeTargetExitIp(candidate.exit_ip)
                  const selected = Boolean(ip && value === ip)
                  return (
                    <li key={candidate.exit_ip}>
                      <button
                        type='button'
                        className={`w-full space-y-1 p-3 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 ${selected ? 'bg-accent ring-1 ring-primary ring-inset' : ''}`}
                        disabled={disabled}
                        aria-pressed={selected}
                        aria-label={`选择公网 IP ${candidate.exit_ip}`}
                        onClick={() => onSelect(candidate.exit_ip)}
                      >
                        <span className='flex flex-wrap items-center gap-x-2 gap-y-1'>
                          <span className='font-mono break-all'>
                            {candidate.exit_ip}
                          </span>
                          {ip && ip === normalizedCurrentIp ? (
                            <span className='text-xs text-muted-foreground'>
                              当前出口
                            </span>
                          ) : null}
                          {selected ? (
                            <span className='text-xs text-primary'>已选择</span>
                          ) : null}
                        </span>
                        <span className='block break-words'>
                          {candidateLocation(candidate)}
                        </span>
                        <span className='flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground'>
                          <span>
                            距首次位置：{formatDistance(candidate.distance_km)}
                          </span>
                          <span>
                            分数：{candidateMetric(candidate.quality_score)}
                          </span>
                          <span>
                            延迟：{candidateMetric(candidate.latency_ms, ' ms')}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p role='status' className='p-3 text-sm text-muted-foreground'>
                {candidates.length
                  ? '没有匹配的 IP 或地区，请修改搜索条件。'
                  : data.complete
                    ? '当前没有可用 IP，可刷新列表或手动输入后由上游核验。'
                    : '暂未读取到候选 IP，可刷新重试或手动输入。'}
              </p>
            )}
          </div>
          <p className='text-xs text-muted-foreground'>
            {search.trim()
              ? `匹配 ${filtered.length} / ${candidates.length} 个。`
              : ''}
            按 IP 池就近顺序排列；确认时会重新核验可用性。
            {fetchedAt && Number.isFinite(fetchedAt.getTime())
              ? ` 读取于 ${fetchedAt.toLocaleString()}。`
              : ' 读取时间未知。'}
          </p>
        </>
      ) : null}
    </section>
  )
}
