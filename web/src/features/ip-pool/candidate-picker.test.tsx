import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { poolCandidatesQueryOptions } from './api'
import { PoolCandidatePicker } from './candidate-picker'
import type { IpPoolCandidates } from './model'

const vmId = 'vm-fixture'
const data: IpPoolCandidates = {
  candidates: [
    {
      proxy_id: 'near',
      exit_ip: '203.0.113.9',
      country_code: 'US',
      region: 'Arizona',
      city: 'Phoenix',
      distance_km: 0,
      quality_score: 0,
      latency_ms: 0,
    },
    { proxy_id: 'far', exit_ip: '2001:db8::9' },
  ],
  complete: true,
  fetched_at: '2026-10-22T15:00:00Z',
}

function render({
  result = data,
  disabled = false,
  error,
}: {
  result?: IpPoolCandidates | null
  disabled?: boolean
  error?: Error
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retryOnMount: false } },
  })
  const key = poolCandidatesQueryOptions(vmId).queryKey
  if (result) client.setQueryData(key, result)
  if (error) {
    client
      .getQueryCache()
      .build(client, { queryKey: key })
      .setState({ status: 'error', error })
  }
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <PoolCandidatePicker
        vmId={vmId}
        currentIp='203.0.113.9'
        value='2001:db8::9'
        disabled={disabled}
        onSelect={() => {}}
      />
    </QueryClientProvider>
  )
  client.clear()
  return html
}

describe('IP pool candidate picker', () => {
  it('lists every candidate in upstream order, marks the selected and current IP, and preserves unknowns', () => {
    const html = render()
    expect(html).toContain('共 2 个可用 IP')
    expect(html.indexOf('选择公网 IP 203.0.113.9')).toBeLessThan(
      html.indexOf('选择公网 IP 2001:db8::9')
    )
    expect(html).toContain('当前出口')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('已选择')
    expect(html).toContain('US · Arizona · Phoenix')
    expect(html).toContain('地区未知')
    expect(html).toContain('距首次位置：0 公里')
    expect(html).toContain('分数：0')
    expect(html).toContain('延迟：0 ms')
    expect(html).toContain('距首次位置：未知')
    expect(html).toContain('分数：未知')
    expect(html).toContain('延迟：未知')
    expect(html).toContain('确认时会重新核验可用性')
  })

  it('labels partial results instead of claiming the pool total', () => {
    const html = render({ result: { ...data, complete: false } })
    expect(html).toContain('已加载 2 个 IP（部分结果）')
    expect(html).toContain('当前数量不是 IP 池总数')
    expect(html).not.toContain('共 2 个可用 IP')
  })

  it('keeps an empty result and a loading query distinct', () => {
    expect(render({ result: null })).toContain('正在读取可用 IP')
    expect(render({ result: { ...data, candidates: [] } })).toContain(
      '当前没有可用 IP'
    )
    expect(
      render({ result: { ...data, complete: false, candidates: [] } })
    ).toContain('暂未读取到候选 IP')
  })

  it('labels retained data as old after a refresh error while leaving manual input available', () => {
    const html = render({ error: new Error('上游暂不可用') })
    expect(html).toContain('读取候选 IP 失败：上游暂不可用')
    expect(html).toContain('可刷新重试或手动输入')
    expect(html).toContain('下方为上次读取的结果')
  })

  it('shows the first read failure without a false empty or loading result', () => {
    const html = render({ result: null, error: new Error('连接超时') })
    expect(html).toContain('读取候选 IP 失败：连接超时')
    expect(html).not.toContain('正在读取可用 IP')
    expect(html).not.toContain('当前没有可用 IP')
    expect(html).not.toContain('上次读取')
  })

  it('disables selection, search and refresh while an action is busy', () => {
    const html = render({ disabled: true })
    const buttons = html.match(/<button\b[^>]*>/g) ?? []
    expect(buttons).toHaveLength(3)
    expect(buttons.every((button) => button.includes('disabled=""'))).toBe(true)
    expect(html).toMatch(/<input[^>]*disabled=""/)
  })
})
