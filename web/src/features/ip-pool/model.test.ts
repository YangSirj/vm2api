import { describe, expect, it } from 'vitest'
import {
  assignmentApplied,
  deletionLabel,
  formatDistance,
  incidentTime,
  poolActions,
  poolManaged,
  type IpPoolView,
} from './model'

const applied: IpPoolView = {
  configured: true,
  vm_id: 'account-1',
  state: 'applied',
  assignment: {
    assignment_id: 'assignment-1',
    version: 2,
    state: 'active',
    current_exit_ip: '203.0.113.7',
  },
  applied: {
    exit_ip: '203.0.113.7',
    assignment_version: 2,
    verified_at: '2026-10-22T08:00:00Z',
  },
}

describe('IP pool account actions', () => {
  it('protects the login IP while still allowing verification, copying and ending login', () => {
    const view: IpPoolView = {
      ...applied,
      state: 'login_locked',
      login_locked: true,
    }
    const allowed = poolActions(view)
    expect(allowed.access).toBe(true)
    expect(allowed.probe).toBe(true)
    expect(allowed['login-unlock']).toBe(true)
    expect(allowed.assign).toBe(false)
    expect(allowed.replace).toBe(false)
    expect(allowed.release).toBe(false)
    expect(allowed.apply).toBe(false)
    // A confirmed ban may immediately hold the account, even during login.
    expect(allowed.blacklist).toBe(true)
  })

  it('does not expose a login link for an unapplied replacement, even at the same IP', () => {
    const view: IpPoolView = {
      ...applied,
      state: 'pending',
      assignment: { ...applied.assignment!, version: 3 },
    }
    expect(assignmentApplied(view)).toBe(false)
    const allowed = poolActions(view)
    expect(allowed.apply).toBe(true)
    expect(allowed.access).toBe(false)
    expect(allowed.replace).toBe(false)
    expect(allowed['login-lock']).toBe(false)
  })

  it('offers reconciliation after an unknown allocation result without offering another allocation', () => {
    const view: IpPoolView = {
      configured: true,
      vm_id: 'account-1',
      state: 'pending',
    }
    expect(poolManaged(view)).toBe(true)
    expect(poolActions(view).apply).toBe(true)
    expect(poolActions(view).probe).toBe(false)
    expect(poolActions(view).assign).toBe(false)
    // Only an authoritative reconciliation that found no assignment enables a new allocation.
    expect(
      poolActions({
        ...view,
        state: 'error',
        error: { code: 'ASSIGNMENT_MISSING', message: '分配不存在' },
      }).assign
    ).toBe(true)
  })

  it('keeps pending release cleanup under pool management and frees legacy controls only when released', () => {
    expect(poolManaged({ ...applied, state: 'pending' })).toBe(true)
    expect(poolManaged({ ...applied, state: 'released' })).toBe(false)
    expect(
      poolManaged({ ...applied, state: 'released', login_locked: true })
    ).toBe(true)
    expect(
      poolManaged({
        configured: true,
        vm_id: 'account-1',
        state: 'unassigned',
        operation: { id: 'op-1', type: 'assign', phase: 'running' },
      })
    ).toBe(true)
  })

  it('does not turn an ordinary request error into a confirmed account ban', () => {
    const view: IpPoolView = {
      ...applied,
      state: 'error',
      error: { code: 'connection_timeout', message: '连接超时' },
    }
    expect(poolActions(view).apply).toBe(true)
    expect(poolActions(view)['retry-deletion']).toBe(false)
    expect(view.blacklist).toBeUndefined()
  })

  it('only reports confirmed upstream deletion as complete', () => {
    const blacklist: NonNullable<IpPoolView['blacklist']> = {
      blacklist_id: 'blacklist-1',
      deletion_state: 'failed',
      retryable: true,
      endpoint_access_revoked: false,
    }
    const view: IpPoolView = { ...applied, state: 'blacklisted', blacklist }
    expect(deletionLabel(blacklist)).toBe('已标黑，删除失败')
    expect(poolActions(view)['retry-deletion']).toBe(true)
    expect(poolActions(view).access).toBe(false)
    expect(poolActions(view).assign).toBe(false)
    expect(poolActions(view).apply).toBe(false)
    expect(poolActions({ ...view, login_locked: true })['login-unlock']).toBe(
      false
    )
    expect(
      poolActions({
        ...view,
        blacklist: { ...blacklist, deletion_state: 'succeeded' },
      })['retry-deletion']
    ).toBe(false)
    expect(
      poolActions({
        ...view,
        blacklist: null,
        error: { code: 'TIMEOUT', message: '操作结果未知' },
      })['retry-deletion']
    ).toBe(true)
  })
})

describe('IP pool displayed evidence', () => {
  it('preserves zero distance and labels missing or invalid distance as unknown', () => {
    expect(formatDistance(0)).toBe('0 公里')
    expect(formatDistance(null)).toBe('未知')
    expect(formatDistance(Number.NaN)).toBe('未知')
    expect(formatDistance(-1)).toBe('未知')
  })

  it('requires a real historical incident time before submitting a blacklist confirmation', () => {
    const now = Date.parse('2026-10-22T08:00:00Z')
    expect(incidentTime('2026-10-22T07:00:00Z', now)).toBe(
      '2026-10-22T07:00:00.000Z'
    )
    expect(incidentTime('2026-10-22T09:00:00Z', now)).toBeNull()
    expect(incidentTime('', now)).toBeNull()
  })
})
