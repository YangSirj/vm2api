import type { IpPoolCandidate } from './model'

export function filterPoolCandidates(
  candidates: IpPoolCandidate[],
  search: string
) {
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return candidates
  return candidates.filter((candidate) => {
    const text = [
      candidate.exit_ip,
      candidate.country_code,
      candidate.region,
      candidate.city,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return terms.every((term) => text.includes(term))
  })
}

export function candidateLocation(candidate: IpPoolCandidate) {
  return (
    [candidate.country_code, candidate.region, candidate.city]
      .filter(Boolean)
      .join(' · ') || '地区未知'
  )
}

export function candidateMetric(value: number | null | undefined, suffix = '') {
  if (value == null || !Number.isFinite(value) || value < 0) return '未知'
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)}${suffix}`
}
