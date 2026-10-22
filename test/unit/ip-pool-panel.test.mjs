import test from 'node:test'
import assert from 'node:assert/strict'
import { createIpPoolPanel } from '../../src/lib/ip-pool/panel.mjs'

function fixture({ configured = true } = {}) {
  const state = { configured: true, vm_id: 'vm-01', state: 'applied' }
  const calls = []
  let bodyReads = 0
  const service = {
    view: () => state,
    isManaged: (id) => id === 'vm-01',
    isLocked: () => state.state === 'login_locked',
    busy: () => false,
    execute: async (id, action, body) => {
      calls.push({ id, action, body })
      if (action === 'login-lock') state.state = 'login_locked'
      return action === 'access' ? { uri: 'vless://test-only', expected_exit_ip: '192.0.2.1' } : state
    },
  }
  const responses = []
  const headers = {}
  const ctx = {
    ipPoolService: configured ? service : null,
    readBody: async (req) => {
      bodyReads += 1
      return req.body || {}
    },
    proxyPool: { snapshot: () => ({ proxies: [{ id: 'px-01', bound_vm_ids: ['vm-01'] }] }) },
    json: (_res, status, payload) => responses.push({ status, payload }),
  }
  return {
    panel: createIpPoolPanel(ctx, { env: {} }),
    res: {
      setHeader: (name, value) => {
        headers[name] = value
      },
    },
    state,
    service,
    calls,
    responses,
    headers,
    bodyReads: () => bodyReads,
  }
}
const admin = (method, body) => ({ method, panelRole: 'admin', panelUser: 'test', body })

test('unconfigured integration is a read-only optional feature', async () => {
  const f = fixture({ configured: false })
  await f.panel.handle(admin('GET'), f.res, '/api/panel/ip-pool/vms/vm-01')
  assert.equal(f.responses[0].payload.data.configured, false)
  assert.equal(f.bodyReads(), 0)
})

test('only admins can read IP pool state or obtain access', async () => {
  const f = fixture()
  await f.panel.handle(
    { method: 'POST', panelRole: 'user', panelUser: 'test' },
    f.res,
    '/api/panel/ip-pool/vms/vm-01/access',
  )
  assert.equal(f.responses[0].status, 403)
  assert.equal(f.calls.length, 0)
})

test('access is never cacheable and only explicit POST obtains a link', async () => {
  const f = fixture()
  await f.panel.handle(admin('GET'), f.res, '/api/panel/ip-pool/vms/vm-01')
  assert.equal(f.calls.length, 0)
  await f.panel.handle(admin('POST'), f.res, '/api/panel/ip-pool/vms/vm-01/access')
  assert.equal(f.headers['Cache-Control'], 'no-store')
  assert.deepEqual(
    f.calls.map((c) => c.action),
    ['access'],
  )
  assert.equal(f.responses[1].payload.data.uri, 'vless://test-only')
})

test('admins can read candidates without reading a body or executing an operation', async () => {
  const f = fixture()
  const result = { vm_id: 'vm-02', candidates: [{ id: 'candidate-01' }] }
  const candidateCalls = []
  f.service.candidates = async (vmId) => {
    candidateCalls.push(vmId)
    return result
  }
  assert.equal(await f.panel.handle(admin('GET'), f.res, '/api/panel/ip-pool/vms/vm-02/candidates'), true)
  assert.deepEqual(candidateCalls, ['vm-02'])
  assert.deepEqual(f.responses, [{ status: 200, payload: { ok: true, data: result } }])
  assert.equal(f.headers['Cache-Control'], 'no-store')
  assert.equal(f.bodyReads(), 0)
  assert.equal(f.calls.length, 0)
  assert.equal(f.state.state, 'applied')
})

test('nonadmins cannot read candidates', async () => {
  const f = fixture()
  f.service.candidates = async () => assert.fail('authorization must precede candidate lookup')
  await f.panel.handle(
    { method: 'GET', panelRole: 'user', panelUser: 'test' },
    f.res,
    '/api/panel/ip-pool/vms/vm-01/candidates',
  )
  assert.equal(f.responses[0].status, 403)
  assert.equal(f.responses[0].payload.error.code, 'forbidden')
  assert.equal(f.headers['Cache-Control'], 'no-store')
  assert.equal(f.bodyReads(), 0)
  assert.equal(f.calls.length, 0)
})

test('candidates require a configured IP pool', async () => {
  const f = fixture({ configured: false })
  await f.panel.handle(admin('GET'), f.res, '/api/panel/ip-pool/vms/vm-01/candidates')
  assert.equal(f.responses[0].status, 503)
  assert.equal(f.responses[0].payload.error.code, 'ip_pool_not_configured')
  assert.equal(f.headers['Cache-Control'], 'no-store')
  assert.equal(f.bodyReads(), 0)
  assert.equal(f.calls.length, 0)
})

test('candidate lookup failures use the safe error response without executing an operation', async () => {
  const f = fixture()
  f.service.candidates = async () => {
    throw new Error('sensitive upstream failure')
  }
  await f.panel.handle(admin('GET'), f.res, '/api/panel/ip-pool/vms/vm-01/candidates')
  assert.equal(f.responses[0].status, 409)
  assert.deepEqual(f.responses[0].payload, {
    ok: false,
    error: { code: 'ip_pool_failed', message: 'IP 池操作失败，请核对当前状态后再继续。' },
  })
  assert.equal(f.headers['Cache-Control'], 'no-store')
  assert.equal(f.bodyReads(), 0)
  assert.equal(f.calls.length, 0)
})

test('legacy binding cannot bypass IP-pool ownership using a new proxy', async () => {
  const f = fixture()
  const handled = await f.panel.handle(admin('POST', { vm_id: 'vm-01' }), f.res, '/api/panel/proxies/px-free/bind')
  assert.equal(handled, true)
  assert.equal(f.responses[0].payload.error.code, 'ip_pool_managed')
})

test('legacy edits to a bound managed proxy are rejected before mutation', async () => {
  const f = fixture()
  await f.panel.handle(admin('DELETE'), f.res, '/api/panel/proxies/px-01')
  assert.equal(f.responses[0].status, 409)
})

test('only VM deletion may pass the completed IP-pool cleanup check', async () => {
  const f = fixture()
  f.state.state = 'blacklisted'
  let checks = 0
  f.service.canDelete = async () => {
    checks += 1
    return true
  }
  assert.equal(await f.panel.handle(admin('DELETE'), f.res, '/api/panel/vms/vm-01'), false)
  assert.equal(checks, 1)
  for (const action of ['reset', 'recreate', 'package', 'allocate-proxy']) {
    assert.equal(await f.panel.handle(admin('POST'), f.res, `/api/panel/vms/vm-01/${action}`), true)
    assert.equal(f.responses.at(-1).payload.error.code, 'ip_pool_managed')
  }
  assert.equal(await f.panel.handle(admin('PATCH', { proxy_id: 'px-free' }), f.res, '/api/panel/vms/vm-01'), true)
  assert.equal(f.responses.at(-1).payload.error.code, 'ip_pool_managed')
  assert.equal(await f.panel.handle(admin('POST'), f.res, '/api/panel/vms/vm-01/oauth/exchange'), true)
  assert.equal(f.responses.at(-1).payload.error.code, 'ip_pool_login_lock_required')
  assert.equal(checks, 1)
})

test('unfinished cleanup and busy IP operations still block VM deletion', async () => {
  const f = fixture()
  f.service.canDelete = async () => false
  assert.equal(await f.panel.handle(admin('DELETE'), f.res, '/api/panel/vms/vm-01'), true)
  assert.equal(f.responses.at(-1).payload.error.code, 'ip_pool_managed')
  f.service.busy = () => true
  f.service.canDelete = async () => {
    assert.fail('busy deletion must be rejected before checking cleanup')
  }
  assert.equal(await f.panel.handle(admin('DELETE'), f.res, '/api/panel/vms/vm-01'), true)
  assert.equal(f.responses.at(-1).payload.error.code, 'ip_pool_busy')
})

test('unmanaged legacy request body remains available to the original route', async () => {
  const f = fixture()
  const req = admin('POST', { vm_id: 'vm-02' })
  assert.equal(await f.panel.handle(req, f.res, '/api/panel/proxies/px-free/bind'), false)
  assert.deepEqual(await f.panel.readBody(req, 65536), { vm_id: 'vm-02' })
  assert.equal(f.bodyReads(), 1)
})

test('managed OAuth start locks IP before generating authorization URL', async () => {
  const f = fixture()
  assert.equal(await f.panel.handle(admin('POST'), f.res, '/api/panel/vms/vm-01/oauth/generate-auth-url'), false)
  assert.equal(f.state.state, 'login_locked')
  assert.equal(f.calls[0].action, 'login-lock')
})

test('an unfinished or failed binding cannot send an admin model probe', async () => {
  const f = fixture()
  f.state.state = 'pending'
  assert.equal(await f.panel.handle(admin('POST'), f.res, '/api/panel/vms/vm-01/test-chat'), true)
  assert.equal(f.responses[0].payload.error.code, 'ip_pool_maintenance')
})

test('a held stopped slot may start so its exit can subsequently be verified', async () => {
  const f = fixture()
  f.state.state = 'error'
  assert.equal(await f.panel.handle(admin('POST'), f.res, '/api/panel/vms/vm-01/start'), false)
  assert.equal(f.state.state, 'error')
})
