import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { poolCandidatesQueryOptions } from './api'

vi.mock('@/lib/api', () => ({ api: vi.fn(), isApiError: vi.fn() }))

afterEach(() => vi.resetAllMocks())

describe('IP pool candidates read-only query', () => {
  it('loads candidates for only the encoded VM and carries cancellation without a mutation body', async () => {
    const result = {
      candidates: [],
      complete: true,
      fetched_at: '2026-10-22T15:00:00Z',
    }
    vi.mocked(api).mockResolvedValue(result)
    const client = new QueryClient()
    expect(
      await client.fetchQuery(poolCandidatesQueryOptions('vm /01'))
    ).toEqual(result)
    expect(api).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/ip-pool/vms/vm%20%2F01/candidates',
      { signal: expect.any(AbortSignal) }
    )
    client.clear()
  })

  it('does not automatically retry a failed read and refreshes on reopening only', async () => {
    vi.mocked(api).mockRejectedValue(new Error('unavailable'))
    const client = new QueryClient()
    const options = poolCandidatesQueryOptions('vm-01')
    await expect(client.fetchQuery(options)).rejects.toThrow('unavailable')
    expect(api).toHaveBeenCalledTimes(1)
    expect(options).toMatchObject({
      retry: false,
      refetchOnMount: 'always',
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })
    client.clear()
  })
})
