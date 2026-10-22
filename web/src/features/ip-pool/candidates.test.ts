import { describe, expect, it } from 'vitest'
import {
  candidateLocation,
  candidateMetric,
  filterPoolCandidates,
} from './candidates'
import type { IpPoolCandidate } from './model'

const candidates: IpPoolCandidate[] = [
  {
    proxy_id: 'near',
    exit_ip: '203.0.113.9',
    country_code: 'US',
    region: 'Arizona',
    city: 'Phoenix',
  },
  {
    proxy_id: 'far',
    exit_ip: '2001:db8::9',
    country_code: 'US',
    region: 'California',
    city: 'Los Angeles',
  },
  { proxy_id: 'unknown', exit_ip: '198.51.100.2' },
]

describe('IP pool candidate search and measured fields', () => {
  it('matches IPs and case-insensitive country, region and city without reordering', () => {
    expect(filterPoolCandidates(candidates, ' ')).toBe(candidates)
    expect(filterPoolCandidates(candidates, 'us')).toEqual(
      candidates.slice(0, 2)
    )
    expect(filterPoolCandidates(candidates, ' US   arizona phoenix ')).toEqual([
      candidates[0],
    ])
    expect(filterPoolCandidates(candidates, 'Los Angeles')).toEqual([
      candidates[1],
    ])
    expect(filterPoolCandidates(candidates, '2001:db8')).toEqual([
      candidates[1],
    ])
    expect(filterPoolCandidates(candidates, '198.51.100.2')).toEqual([
      candidates[2],
    ])
    expect(filterPoolCandidates(candidates, 'not-found')).toEqual([])
  })

  it('shows only provided geography and never invents a location', () => {
    expect(candidateLocation(candidates[0])).toBe('US · Arizona · Phoenix')
    expect(candidateLocation(candidates[2])).toBe('地区未知')
  })

  it('keeps measured zero values and labels missing or invalid measurements unknown', () => {
    expect(candidateMetric(0)).toBe('0')
    expect(candidateMetric(0, ' ms')).toBe('0 ms')
    expect(candidateMetric(12.34, ' ms')).toBe('12.3 ms')
    for (const value of [null, undefined, Number.NaN, Infinity, -1]) {
      expect(candidateMetric(value, ' ms')).toBe('未知')
    }
  })
})
