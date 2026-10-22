import { describe, expect, it } from 'vitest'
import { validateVmDetailSearch } from './detail-search'

describe('VM detail tab deep links', () => {
  it('preserves supported tabs for refresh and direct IP management links', () => {
    for (const tab of ['overview', 'account', 'proxy', 'test', 'ops', 'seed']) {
      expect(validateVmDetailSearch({ tab })).toEqual({ tab })
    }
  })

  it('ignores unknown or malformed tab values', () => {
    for (const tab of [undefined, null, 3, ['proxy'], 'missing']) {
      expect(validateVmDetailSearch({ tab })).toEqual({})
    }
  })
})
