import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIpPoolService } from '../../src/lib/ip-pool/service.mjs'
import { IpPoolError } from '../../src/lib/ip-pool/client.mjs'
import { loadIpPoolState, saveIpPoolState } from '../../src/lib/ip-pool/state.mjs'

const VM = 'vm-01'
const FIRST = '192.0.2.10'
const SECOND = '192.0.2.20'
const SECRET = 'synthetic-access-secret'
const clone = (value) => JSON.parse(JSON.stringify(value))

test('timezone failure keeps the allocated exit pending and does not restore or settle', async (t) => {
  const { service, adapter, env, log } = await fixture(t)
  adapter.apply = async () => {
    throw Object.assign(new Error('timezone'), { code: 'TIMEZONE_LOOKUP_FAILED' })
  }
  assert.equal((await service.execute(VM, 'assign')).error.code, 'TIMEZONE_LOOKUP_FAILED')
  assert.ok(env.marker)
  assert.equal(
    log.some(([action]) => action === 'restore' || action === 'settle'),
    false,
  )
  assert.equal(env.assignment.current_exit_ip, FIRST)
})

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vm2api-pool-service-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFile = join(directory, 'private', 'state.json')
  const log = []
  const env = {
    assignment: null,
    marker: null,
    vmProxy: { id: 'legacy', password: SECRET },
    actualExit: FIRST,
    oldSchedule: { schedulable: false, schedule_manual: false, hold: 'no_credential' },
    bridges: new Map(),
  }
  const client = {
    async capabilities() {
      log.push(['capabilities'])
      return { features: { exact_exit_ip: true } }
    },
    async assign(body) {
      log.push(['assign', clone(body)])
      env.assignment ||= {
        assignment_id: 'asg_1',
        version: 1,
        state: 'active',
        current_exit_ip: FIRST,
        current_proxy_id: 'px_1',
        consumer_ref: body.consumer_ref,
        anchor: { exit_ip: FIRST, country_code: 'US', latitude: 34, longitude: -118 },
        policy: body.policy,
        uri: `vless://${SECRET}`,
        fields: { uuid: SECRET },
      }
      return { assignment: clone(env.assignment), created: true }
    },
    async listAssignments(ref) {
      log.push(['list', ref])
      return { assignments: env.assignment ? [clone(env.assignment)] : [] }
    },
    async getAssignment(id) {
      log.push(['get', id])
      return clone(env.assignment)
    },
    async access(id, version) {
      log.push(['access', id, version])
      return {
        assignment_id: id,
        version,
        expected_exit_ip: env.assignment.current_exit_ip,
        protocol: 'vless',
        uri: `vless://${SECRET}`,
        fields: { uuid: SECRET },
      }
    },
    async replace(id, body) {
      log.push(['replace', id, clone(body)])
      assert.equal(body.expected_version, env.assignment.version)
      env.assignment = {
        ...env.assignment,
        version: env.assignment.version + 1,
        current_exit_ip: SECOND,
        current_proxy_id: 'px_2',
      }
      return { assignment: clone(env.assignment) }
    },
    async release(id, body) {
      log.push(['release', id, clone(body)])
      env.assignment = {
        ...env.assignment,
        version: env.assignment.version + 1,
        state: 'released',
        current_exit_ip: null,
        current_proxy_id: null,
      }
      return { assignment: clone(env.assignment) }
    },
    async settle(id) {
      log.push(['settle', id])
      return { settled: false }
    },
    async events(after) {
      log.push(['events', after])
      return { ok: true, data: { events: [] }, next_cursor: '17' }
    },
    async blacklist(body) {
      log.push(['blacklist', clone(body)])
      return {
        blacklist_id: 'bl_1',
        canonical_exit_ip: body.exit_ip_at_event,
        deletion_state: 'failed',
        endpoint_access_revoked: false,
        retryable: true,
        deleted_at: null,
        last_sync_error: SECRET,
        removed_proxies: [{ proxy_id: 'px_1', deleted: false, uuid: SECRET }],
      }
    },
    async retryDeletion(id) {
      log.push(['retry', id])
      return { blacklist_id: id, deletion_state: 'succeeded', retryable: false, endpoint_access_revoked: true }
    },
    async getBlacklist(id) {
      log.push(['getBlacklist', id])
      return { blacklist_id: id, deletion_state: 'failed', retryable: true }
    },
    async request() {
      return { data: { blacklist: [] } }
    },
  }
  const adapter = {
    async capture(id) {
      log.push(['capture', id])
      return { vmId: id, proxy: clone(env.vmProxy), running: true }
    },
    async hold(id, operationId) {
      log.push(['hold', id, operationId])
      if (env.marker && env.marker !== operationId) throw new Error('unrelated marker would be overwritten')
      env.marker = operationId
      return { ok: true }
    },
    async drain(id) {
      log.push(['drain', id])
      return { ok: true, inflight: 0 }
    },
    async apply(id, bridge, expectedExitIp) {
      assert.equal(expectedExitIp, env.assignment.current_exit_ip)
      log.push(['apply', id, bridge.container])
      env.vmProxy = { id: `local-${bridge.port}` }
      env.actualExit = bridge.exit_ip
      return { ok: true, proxy_id: env.vmProxy.id }
    },
    async verify(id, expected) {
      log.push(['verify', id, expected])
      return env.actualExit === expected
        ? { ok: true, exit_ip: expected, verified_at: '2026-10-22T01:00:00Z' }
        : { ok: false, code: 'exit_ip_mismatch', exit_ip: env.actualExit }
    },
    async restore(id, marker) {
      log.push(['restore', id, marker])
      assert.equal(env.marker, marker)
      env.marker = null
      return { ok: true }
    },
    async stopOld(snapshot) {
      log.push(['stopOld', snapshot.proxy?.id])
      return { ok: true }
    },
    async detach(id) {
      log.push(['detach', id])
      env.vmProxy = null
      return { ok: true }
    },
  }
  const runtime = {
    async start({ vmId, assignmentId, access }) {
      const name = `bridge-${access.expected_exit_ip}`
      log.push(['start', name])
      const bridge = {
        ok: true,
        container: name,
        name,
        vmId,
        assignmentId,
        port: access.expected_exit_ip === FIRST ? 24100 : 24101,
        exit_ip: access.expected_exit_ip,
      }
      env.bridges.set(name, bridge)
      return bridge
    },
    async stop(bridge) {
      log.push(['stop', bridge.container])
      env.bridges.delete(bridge.container)
      return { ok: true }
    },
    async inspect(bridge) {
      log.push(['inspect', bridge.container])
      return { ok: true, running: env.bridges.has(bridge.container) }
    },
  }
  const services = []
  const create = () => {
    const service = createIpPoolService({
      client,
      adapter,
      runtime,
      stateFile,
      instanceId: 'test-host',
      pollIntervalMs: 0,
    })
    services.push(service)
    return service
  }
  t.after(() => services.forEach((service) => service.close()))
  return { service: create(), create, client, adapter, runtime, env, log, stateFile }
}

const calls = (fixture, name) => fixture.log.filter((item) => item[0] === name)

test('exact IP allocation and replacement send the canonical target and verify it before restoring', async (t) => {
  const f = await fixture(t)
  let result = await f.service.execute(VM, 'assign', { target_exit_ip: ` ${FIRST} ` })
  assert.equal(result.state, 'applied')
  assert.equal(calls(f, 'assign')[0][1].target_exit_ip, FIRST)
  assert.equal(loadIpPoolState(f.stateFile).vms[VM].requested_exit_ip, undefined)
  result = await f.service.execute(VM, 'replace', { target_exit_ip: SECOND })
  assert.equal(result.state, 'applied')
  assert.equal(result.applied.exit_ip, SECOND)
  assert.equal(calls(f, 'replace')[0][2].target_exit_ip, SECOND)
  assert.equal(f.env.marker, null)
  const count = calls(f, 'start').length
  const version = result.assignment.version
  result = await f.service.execute(VM, 'replace', { target_exit_ip: SECOND })
  assert.equal(result.state, 'applied')
  assert.equal(result.assignment.version, version)
  assert.equal(calls(f, 'replace').length, 1)
  assert.equal(calls(f, 'start').length, count, 'same target only verifies the existing binding')
  assert.equal((await f.service.execute(VM, 'assign', { target_exit_ip: SECOND })).state, 'applied')
  assert.equal(calls(f, 'assign').length, 1)
  assert.equal(calls(f, 'start').length, count, 'same target assign also leaves the existing binding intact')
})

test('invalid target and unsupported upstream fail before maintenance or allocation', async (t) => {
  const f = await fixture(t)
  for (const target of ['', null, 42, 'example.com', '1.2.3.4:80', 'http://1.2.3.4', '[2606:4700::1111]']) {
    await assert.rejects(f.service.execute(VM, 'assign', { target_exit_ip: target }), {
      code: 'INVALID_TARGET_EXIT_IP',
    })
  }
  f.client.capabilities = async () => ({ features: {} })
  await assert.rejects(f.service.execute(VM, 'assign', { target_exit_ip: FIRST }), {
    code: 'EXACT_EXIT_UNSUPPORTED',
  })
  assert.equal(f.log.length, 0)
  assert.equal(f.env.marker, null)
})

test('IPv6 exact targets use canonical form across allocation and returned-address comparison', async (t) => {
  const f = await fixture(t)
  const assign = f.client.assign
  f.client.assign = async (body) => {
    await assign(body)
    f.env.assignment.current_exit_ip = '2606:4700:0:0:0:0:0:1111'
    return { assignment: clone(f.env.assignment) }
  }
  const result = await f.service.execute(VM, 'assign', { target_exit_ip: '2606:4700:0:0::1111' })
  assert.equal(result.state, 'applied')
  assert.equal(calls(f, 'assign')[0][1].target_exit_ip, '2606:4700::1111')
})

test('unavailable exact target never falls back to automatic allocation', async (t) => {
  const f = await fixture(t)
  f.client.assign = async (body) => {
    f.log.push(['assign', clone(body)])
    throw new IpPoolError('CANDIDATE_INELIGIBLE', { status: 409 })
  }
  const result = await f.service.execute(VM, 'assign', { target_exit_ip: SECOND })
  assert.equal(result.error.code, 'CANDIDATE_INELIGIBLE')
  assert.equal(calls(f, 'assign').length, 1)
  assert.equal(calls(f, 'start').length, 0)
  assert.equal(result.assignment, null)
  assert.equal(loadIpPoolState(f.stateFile).vms[VM].requested_exit_ip, undefined)
})

test('a wrong exact allocation is never applied, including after a restart and reconciliation', async (t) => {
  const f = await fixture(t)
  const result = await f.service.execute(VM, 'assign', { target_exit_ip: SECOND })
  assert.equal(result.error.code, 'TARGET_EXIT_IP_MISMATCH')
  assert.equal(calls(f, 'access').length, 0)
  assert.equal(calls(f, 'start').length, 0)
  assert.ok(f.env.marker)
  const service = f.create()
  assert.equal((await service.execute(VM, 'apply')).error.code, 'TARGET_EXIT_IP_MISMATCH')
  for (const action of ['assign', 'replace']) {
    await assert.rejects(service.execute(VM, action), { code: 'RECONCILE_REQUIRED' })
  }
  assert.equal(calls(f, 'assign').length, 1)
  assert.equal(calls(f, 'restore').length, 0)
  assert.equal((await service.execute(VM, 'release')).state, 'released')
  assert.equal(loadIpPoolState(f.stateFile).vms[VM].requested_exit_ip, undefined)
})

test('an existing assignment cannot silently satisfy a different exact allocation target', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  const starts = calls(f, 'start').length
  assert.equal(
    (await f.service.execute(VM, 'assign', { target_exit_ip: SECOND })).error.code,
    'TARGET_EXIT_IP_MISMATCH',
  )
  assert.equal((await f.create().execute(VM, 'apply')).error.code, 'TARGET_EXIT_IP_MISMATCH')
  assert.equal(calls(f, 'start').length, starts)
  assert.equal(calls(f, 'assign').length, 1)
  assert.ok(f.env.marker)
})

test('an unknown exact replacement retains the target and is reconciled without replay', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  const replace = f.client.replace
  f.client.replace = async (id, body) => {
    await replace(id, body)
    throw new IpPoolError('TIMEOUT', { outcomeUnknown: true })
  }
  assert.equal((await f.service.execute(VM, 'replace', { target_exit_ip: SECOND })).state, 'pending')
  const service = f.create()
  await assert.rejects(service.execute(VM, 'replace', { target_exit_ip: SECOND }), { code: 'RECONCILE_REQUIRED' })
  assert.equal((await service.execute(VM, 'apply')).applied.exit_ip, SECOND)
  assert.equal(calls(f, 'replace').length, 1)
  assert.equal(f.env.marker, null)
})

test('target selection cannot bypass a login lock created during the capability query', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  f.client.capabilities = async () => {
    await f.service.execute(VM, 'login-lock')
    return { features: { exact_exit_ip: true } }
  }
  await assert.rejects(f.service.execute(VM, 'replace', { target_exit_ip: SECOND }), { code: 'LOGIN_LOCKED' })
  assert.equal(calls(f, 'replace').length, 0)
})

test('an exact allocation timeout with confirmed absence permits a later explicit allocation', async (t) => {
  const f = await fixture(t)
  const assign = f.client.assign
  f.client.assign = async () => {
    throw new IpPoolError('TIMEOUT', { outcomeUnknown: true })
  }
  assert.equal((await f.service.execute(VM, 'assign', { target_exit_ip: FIRST })).state, 'pending')
  assert.equal((await f.service.execute(VM, 'apply')).error.code, 'ASSIGNMENT_MISSING')
  assert.equal(loadIpPoolState(f.stateFile).vms[VM].requested_exit_ip, undefined)
  f.client.assign = assign
  assert.equal((await f.service.execute(VM, 'assign', { target_exit_ip: FIRST })).state, 'applied')
})

test('a malformed assignment list preserves an unknown exact allocation and its target after restart', async (t) => {
  const f = await fixture(t)
  f.client.assign = async (body) => {
    f.log.push(['assign', clone(body)])
    throw new IpPoolError('TIMEOUT', { outcomeUnknown: true })
  }
  assert.equal((await f.service.execute(VM, 'assign', { target_exit_ip: FIRST })).state, 'pending')
  const service = f.create()
  for (const response of [null, {}, { assignments: null }, { assignments: {} }]) {
    f.client.listAssignments = async () => response
    const result = await service.execute(VM, 'apply')
    assert.equal(result.error.code, 'INVALID_RESPONSE')
    assert.equal(result.state, 'pending')
    const entry = loadIpPoolState(f.stateFile).vms[VM]
    assert.equal(entry.pending_mutation.type, 'assign')
    assert.equal(entry.requested_exit_ip, FIRST)
    assert.ok(f.env.marker)
    await assert.rejects(service.execute(VM, 'assign', { target_exit_ip: SECOND }), {
      code: 'RECONCILE_REQUIRED',
    })
  }
  assert.equal(calls(f, 'assign').length, 1)
  assert.equal(calls(f, 'access').length, 0)
  assert.equal(calls(f, 'start').length, 0)
  assert.equal(calls(f, 'restore').length, 0)
})

test('assign holds and drains before allocation, verifies before restoring, and persists no access credentials', async (t) => {
  const f = await fixture(t)
  assert.equal(f.log.length, 0)
  const result = await f.service.execute(VM, 'assign')
  assert.equal(result.state, 'applied')
  assert.equal(result.applied.exit_ip, FIRST)
  assert.equal(result.operation, null)
  assert.deepEqual(calls(f, 'assign')[0][1], {
    consumer_ref: 'vm2api:test-host:vm-01',
    policy: { exclusive_exit: true, protocols: ['vless'], same_country_required: true, settle_grace_seconds: 900 },
  })
  const names = f.log.map((item) => item[0])
  for (const [before, after] of [
    ['hold', 'drain'],
    ['drain', 'assign'],
    ['verify', 'stopOld'],
    ['stopOld', 'settle'],
    ['settle', 'restore'],
  ]) {
    assert.ok(names.indexOf(before) < names.indexOf(after), `${before} must precede ${after}`)
  }
  assert.equal(f.env.marker, null)
  assert.deepEqual(f.env.oldSchedule, { schedulable: false, schedule_manual: false, hold: 'no_credential' })
  const persisted = await readFile(f.stateFile, 'utf8')
  assert.equal(persisted.includes(SECRET), false)
  assert.equal(persisted.includes('vless://'), false)
  assert.equal(JSON.stringify(result).includes(SECRET), false)
  assert.equal(loadIpPoolState(f.stateFile).vms[VM].capture.proxy.password, undefined)
  if (process.platform !== 'win32') assert.equal((await stat(f.stateFile)).mode & 0o777, 0o600)
})

test('unknown allocation is recovered by consumer_ref without allocating again', async (t) => {
  const f = await fixture(t)
  const assign = f.client.assign
  f.client.assign = async (body) => {
    await assign(body)
    throw new IpPoolError('TIMEOUT', { outcomeUnknown: true })
  }
  const pending = await f.service.execute(VM, 'assign')
  assert.equal(pending.state, 'pending')
  assert.ok(f.env.marker)
  const marker = f.env.marker
  const applied = await f.service.execute(VM, 'apply')
  assert.equal(applied.state, 'applied')
  assert.equal(calls(f, 'assign').length, 1)
  assert.equal(calls(f, 'list').length, 1)
  assert.equal(calls(f, 'restore')[0][2], marker)
})

test('unknown replacement cannot be sent twice and recovery after restart applies the changed assignment', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  const replace = f.client.replace
  f.client.replace = async (...args) => {
    await replace(...args)
    throw new IpPoolError('TIMEOUT', { outcomeUnknown: true })
  }
  const pending = await f.service.execute(VM, 'replace')
  assert.equal(pending.state, 'pending')
  const marker = f.env.marker
  assert.equal((await f.service.execute(VM, 'replace')).state, 'pending')
  assert.equal(calls(f, 'replace').length, 1)
  f.service.close()
  const recovered = f.create()
  const result = await recovered.execute(VM, 'apply')
  assert.equal(result.state, 'applied')
  assert.equal(result.applied.exit_ip, SECOND)
  assert.equal(result.assignment.version, 2)
  assert.equal(calls(f, 'replace').length, 1)
  assert.equal(calls(f, 'restore').at(-1)[2], marker)
  assert.equal(f.env.bridges.has(`bridge-${FIRST}`), false)
})

test('a running operation rejects a concurrent replacement without a second request', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  let proceed
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  const gate = new Promise((resolve) => {
    proceed = resolve
  })
  const replace = f.client.replace
  f.client.replace = async (...args) => {
    started()
    await gate
    return replace(...args)
  }
  const first = f.service.execute(VM, 'replace')
  await ready
  assert.equal(f.service.busy(VM), true)
  await assert.rejects(f.service.execute(VM, 'replace'), { code: 'BUSY', status: 409 })
  proceed()
  assert.equal((await first).state, 'applied')
  assert.equal(calls(f, 'replace').length, 1)
})

test('access locks login and failed unlock retains maintenance and original account holds', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  const link = await f.service.execute(VM, 'access')
  assert.equal(link.uri, `vless://${SECRET}`)
  assert.equal(f.service.isLocked(VM), true)
  assert.equal(f.service.view(VM).state, 'login_locked')
  await assert.rejects(f.service.execute(VM, 'replace'), { code: 'LOGIN_LOCKED' })
  f.env.actualExit = SECOND
  assert.equal((await f.service.execute(VM, 'login-unlock')).state, 'error')
  assert.equal(f.service.isLocked(VM), false)
  assert.ok(f.env.marker)
  f.env.actualExit = FIRST
  assert.equal((await f.service.execute(VM, 'login-unlock')).state, 'applied')
  assert.equal(f.service.isLocked(VM), false)
  assert.equal(f.env.oldSchedule.hold, 'no_credential')
  assert.equal(JSON.stringify(f.service.view(VM)).includes(SECRET), false)
})

test('finishing login after upstream drift releases only the login lock and allows explicit apply recovery', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  await f.service.execute(VM, 'login-lock')
  const marker = f.env.marker
  const restored = calls(f, 'restore').length
  f.env.assignment = { ...f.env.assignment, version: 2, current_exit_ip: SECOND, current_proxy_id: 'px_2' }
  await f.service.pollEvents()
  assert.equal(f.service.view(VM).state, 'pending')
  assert.equal(f.service.isLocked(VM), true)
  const unlocked = await f.service.execute(VM, 'login-unlock')
  assert.equal(unlocked.state, 'pending')
  assert.equal(unlocked.error.code, 'RECONCILE_REQUIRED')
  assert.equal(unlocked.login_locked, false)
  assert.equal(f.env.marker, marker)
  assert.equal(calls(f, 'restore').length, restored)
  const applied = await f.service.execute(VM, 'apply')
  assert.equal(applied.state, 'applied')
  assert.equal(applied.applied.exit_ip, SECOND)
  assert.equal(f.env.marker, null)
  assert.equal(calls(f, 'replace').length, 0)
})

test('an exit mismatch retains maintenance, never settles, and can be applied again without replacement', async (t) => {
  const f = await fixture(t)
  const verify = f.adapter.verify
  f.adapter.verify = async () => ({ ok: false, code: 'exit_ip_mismatch', exit_ip: SECOND })
  const result = await f.service.execute(VM, 'assign')
  assert.equal(result.state, 'error')
  assert.equal(result.error.code, 'EXIT_IP_MISMATCH')
  assert.ok(f.env.marker)
  assert.equal(calls(f, 'settle').length, 0)
  assert.equal(calls(f, 'restore').length, 0)
  f.adapter.verify = verify
  assert.equal((await f.service.execute(VM, 'apply')).state, 'applied')
  assert.equal(calls(f, 'assign').length, 1)
  assert.equal(calls(f, 'replace').length, 0)
})

test('unknown release is reconciled and cleaned up without retaining a dead proxy or repeating release', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  const release = f.client.release
  f.client.release = async (...args) => {
    await release(...args)
    throw new IpPoolError('TIMEOUT', { outcomeUnknown: true })
  }
  assert.equal((await f.service.execute(VM, 'release')).state, 'pending')
  const result = await f.service.execute(VM, 'apply')
  assert.equal(result.state, 'released')
  assert.equal(result.applied, null)
  assert.equal(f.env.vmProxy, null)
  assert.equal(f.env.marker, null)
  assert.equal(f.env.bridges.size, 0)
  assert.equal(calls(f, 'release').length, 1)
  assert.equal(f.service.isManaged(VM), false)
})

test('restart converts an in-progress operation to pending without network calls or discarding its marker', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  const data = loadIpPoolState(f.stateFile)
  data.vms[VM].operation = {
    id: 'interrupted-operation',
    type: 'apply',
    phase: 'applying',
    started_at: '2026-10-22T00:00:00Z',
  }
  data.vms[VM].maintenance_id = 'interrupted-operation'
  f.env.marker = 'interrupted-operation'
  saveIpPoolState(f.stateFile, data)
  const count = f.log.length
  const service = f.create()
  assert.equal(f.log.length, count)
  assert.equal(service.view(VM).state, 'pending')
  assert.equal(service.view(VM).operation, null)
  assert.equal((await service.execute(VM, 'apply')).state, 'applied')
  assert.equal(calls(f, 'restore').at(-1)[2], 'interrupted-operation')
})

test('blacklist uses the verified historical event exit and reports real deletion status', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  await f.service.execute(VM, 'replace')
  const result = await f.service.execute(VM, 'blacklist', {
    confirmation: 'user_confirmed',
    incident_id: 'incident-1',
    exit_ip_at_event: FIRST,
    occurred_at: '2026-10-22T01:00:00Z',
    reason: 'account_banned',
  })
  assert.equal(result.state, 'blacklisted')
  assert.equal(result.blacklist.deletion_state, 'failed')
  assert.equal(result.blacklist.endpoint_access_revoked, false)
  assert.equal(calls(f, 'blacklist')[0][1].exit_ip_at_event, FIRST)
  assert.equal(calls(f, 'blacklist')[0][1].assignment_version_at_event, 1)
  assert.equal(f.env.bridges.size, 0)
  assert.ok(f.env.marker)
  assert.equal(JSON.stringify(result).includes(SECRET), false)
  for (const action of ['assign', 'apply', 'replace', 'login-unlock']) {
    await assert.rejects(f.service.execute(VM, action), { code: 'BLACKLISTED' })
  }
  const retried = await f.service.execute(VM, 'retry-deletion')
  assert.equal(retried.state, 'blacklisted')
  assert.equal(retried.blacklist.deletion_state, 'succeeded')
  assert.equal(retried.blacklist.endpoint_access_revoked, true)
  assert.ok(f.env.marker)
})

test('fully retired banned slots can be deleted without lifting their ban or losing audit evidence', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  await f.service.execute(VM, 'blacklist', {
    confirmation: 'user_confirmed',
    incident_id: 'retired-account',
    exit_ip_at_event: FIRST,
    occurred_at: '2026-10-22T01:00:00Z',
  })
  f.client.retryDeletion = async (id) => ({
    blacklist_id: id,
    deletion_state: 'succeeded',
    endpoint_access_revoked: true,
    inventory_removed: true,
    retryable: false,
  })
  await f.service.execute(VM, 'retry-deletion')
  assert.equal(await f.service.canDelete(VM), false, 'upstream deletion alone does not detach local resources')
  await f.service.execute(VM, 'release')
  const data = loadIpPoolState(f.stateFile)
  data.vms[VM].error = { code: 'ASSIGNMENT_CHANGED', message: 'legacy released-assignment poll' }
  saveIpPoolState(f.stateFile, data)
  const service = f.create()
  const before = clone(loadIpPoolState(f.stateFile).vms[VM])
  assert.equal(await service.canDelete(VM), true)
  assert.equal(service.isManaged(VM), true)
  assert.equal(service.isLocked(VM), true)
  assert.ok(f.env.marker, 'ban maintenance hold remains')
  assert.ok(before.capture?.proxy, 'historical snapshot remains as evidence')
  assert.equal(before.assignment.state, 'released')
  assert.deepEqual(loadIpPoolState(f.stateFile).vms[VM], before)
  for (const action of ['assign', 'apply', 'replace', 'access', 'login-lock', 'login-unlock']) {
    await assert.rejects(service.execute(VM, action), { code: 'BLACKLISTED' })
  }

  let drained
  let started
  const drainStarted = new Promise((resolve) => {
    started = resolve
  })
  const originalDrain = f.adapter.drain
  f.adapter.drain = async () => {
    started()
    return new Promise((resolve) => {
      drained = resolve
    })
  }
  const releasing = service.execute(VM, 'release')
  await drainStarted
  assert.equal(await service.canDelete(VM), false, 'a concurrent cleanup must finish before deletion')
  drained({ ok: true, inflight: 0 })
  await releasing
  f.adapter.drain = originalDrain

  const incomplete = [
    ['active assignment', { assignment: { ...before.assignment, state: 'active' } }],
    ['missing assignment', { assignment: null }],
    ['applied bridge', { applied: { runtime: { container: 'old-bridge' } } }],
    ['staged bridge', { staged: { runtime: { container: 'new-bridge' } } }],
    ['old connection', { previous: [{ snapshot: { proxy: { id: 'old-proxy' } } }] }],
    ['pending mutation', { pending_mutation: { type: 'release' } }],
    ['pending apply', { pending_apply: true }],
    ['pending release', { pending_release: true }],
    ['interrupted operation', { operation: { id: f.env.marker, type: 'release' } }],
    ['login lock', { login_locked: true }],
    ['upstream deletion failed', { blacklist: { ...before.blacklist, deletion_state: 'failed' } }],
    ['access not revoked', { blacklist: { ...before.blacklist, endpoint_access_revoked: false } }],
    ['inventory not removed', { blacklist: { ...before.blacklist, inventory_removed: false } }],
    ['cleanup failure', { error: { code: 'CLEANUP_FAILED', message: 'not cleaned' } }],
  ]
  for (const [reason, change] of incomplete) {
    const altered = clone(data)
    Object.assign(altered.vms[VM], change)
    saveIpPoolState(f.stateFile, altered)
    assert.equal(await f.create().canDelete(VM), false, reason)
  }
  saveIpPoolState(f.stateFile, data)
  f.env.vmProxy = { id: 'unexpected-live-binding' }
  assert.equal(await f.create().canDelete(VM), false, 'current binding overrides historical cleanup evidence')
  f.env.vmProxy = null
  f.adapter.capture = async () => {
    throw new Error('cannot inspect VM')
  }
  assert.equal(await f.create().canDelete(VM), false, 'unverified binding remains protected')

  f.adapter.hold = async () => {
    throw new Error('VM was removed; must not be held again')
  }
  f.client.getAssignment = async () => {
    throw new Error('retired assignment must not be polled')
  }
  assert.equal((await f.create().pollEvents()).ok, true)
  assert.deepEqual(loadIpPoolState(f.stateFile).vms[VM], before, 'terminal polling retains the ban audit unchanged')
})

test('unverified blacklist evidence is rejected and a confirmed ban survives a failed drain', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  const body = {
    confirmation: 'user_confirmed',
    incident_id: 'incident-2',
    exit_ip_at_event: SECOND,
    occurred_at: '2026-10-22T01:00:00Z',
  }
  await assert.rejects(f.service.execute(VM, 'blacklist', body), { code: 'BAN_EVIDENCE_REQUIRED' })
  assert.equal(calls(f, 'blacklist').length, 0)
  f.adapter.drain = async () => ({ ok: false, inflight: 1 })
  const result = await f.service.execute(VM, 'blacklist', { ...body, exit_ip_at_event: FIRST })
  assert.equal(result.state, 'blacklisted')
  assert.ok(f.env.marker)
  await assert.rejects(f.service.execute(VM, 'assign'), { code: 'BLACKLISTED' })
})

test('polling detects assignment drift, holds without access calls, and pauses after 401 until a manual action', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  const accessCount = calls(f, 'access').length
  f.env.assignment = { ...f.env.assignment, current_exit_ip: SECOND }
  assert.equal((await f.service.pollEvents()).ok, true)
  assert.equal(f.service.view(VM).state, 'pending')
  assert.ok(f.env.marker)
  assert.equal(calls(f, 'access').length, accessCount)
  const events = f.client.events
  let authCalls = 0
  f.client.events = async () => {
    authCalls += 1
    throw new IpPoolError('UNAUTHENTICATED', { status: 401 })
  }
  assert.equal((await f.service.pollEvents()).auth_paused, true)
  assert.deepEqual(await f.service.pollEvents(), { skipped: true })
  assert.equal(authCalls, 1)
  f.client.events = events
  assert.equal((await f.service.execute(VM, 'apply')).state, 'applied')
  assert.equal((await f.service.pollEvents()).ok, true)
})

test('expired event cursors reconcile known assignments before restarting event consumption', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  await f.service.pollEvents()
  let first = true
  f.client.events = async (after) => {
    f.log.push(['events', after])
    if (first) {
      first = false
      throw new IpPoolError('CURSOR_EXPIRED', { status: 410 })
    }
    return { ok: true, data: { events: [] }, next_cursor: '21' }
  }
  f.log.length = 0
  assert.equal((await f.service.pollEvents()).ok, true)
  assert.deepEqual(
    f.log.slice(0, 3).map((item) => item[0]),
    ['events', 'get', 'events'],
  )
  assert.equal(f.log[2][1], '0')
  assert.equal(loadIpPoolState(f.stateFile).event_cursor, '21')
})

test('old egress cleanup failure prevents settling and resumes safely through apply', async (t) => {
  const f = await fixture(t)
  const stopOld = f.adapter.stopOld
  f.adapter.stopOld = async () => ({ ok: false, code: 'old_egress_stop_failed' })
  assert.equal((await f.service.execute(VM, 'assign')).state, 'error')
  assert.ok(f.env.marker)
  assert.equal(calls(f, 'settle').length, 0)
  assert.equal(calls(f, 'restore').length, 0)
  f.adapter.stopOld = stopOld
  assert.equal((await f.service.execute(VM, 'apply')).state, 'applied')
  assert.equal(calls(f, 'assign').length, 1)
  assert.equal(
    calls(f, 'stopOld').some((item) => item[1] === 'legacy'),
    true,
  )
})

test('release cleanup can resume after a failed settle with an already removed bridge', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  const settle = f.client.settle
  f.client.settle = async () => {
    throw new IpPoolError('NETWORK_ERROR', { outcomeUnknown: true })
  }
  assert.equal((await f.service.execute(VM, 'release')).state, 'pending')
  assert.equal(f.env.bridges.size, 0)
  assert.equal(f.env.vmProxy, null)
  assert.ok(f.env.marker)
  f.client.settle = settle
  assert.equal((await f.service.execute(VM, 'apply')).state, 'released')
  assert.equal(calls(f, 'release').length, 1)
  assert.equal(f.env.marker, null)
  assert.equal(f.service.isManaged(VM), false)
})

test('a missing blacklist record is retried with the original confirmed incident, and an existing record only retries deletion', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  const original = f.client.blacklist
  let fail = true
  f.client.blacklist = async (body) => {
    if (fail) {
      f.log.push(['blacklist', clone(body)])
      fail = false
      throw new IpPoolError('TIMEOUT', { outcomeUnknown: true })
    }
    return original(body)
  }
  const evidence = {
    confirmation: 'user_confirmed',
    incident_id: 'incident-timeout',
    exit_ip_at_event: FIRST,
    occurred_at: '2026-10-22T01:00:00Z',
    reason: 'account_banned',
  }
  assert.equal((await f.service.execute(VM, 'blacklist', evidence)).state, 'blacklisted')
  assert.equal((await f.service.execute(VM, 'retry-deletion')).blacklist.deletion_state, 'failed')
  assert.deepEqual(calls(f, 'blacklist')[0][1], calls(f, 'blacklist')[1][1])
  assert.equal(calls(f, 'retry').length, 0)
  assert.equal((await f.service.execute(VM, 'retry-deletion')).blacklist.deletion_state, 'succeeded')
  assert.equal(calls(f, 'blacklist').length, 2)
  assert.equal(calls(f, 'retry').length, 1)
})

test('real proxy events affect only the current proxy and are deduplicated after handling', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  await f.service.execute(VM, 'replace')
  const response = (events, cursor) => ({ ok: true, data: { events }, next_cursor: cursor })
  const event = {
    event_id: 'ev_18',
    type: 'proxy.credential_rotated',
    entity_id: 'px_1',
    occurred_at: '2026-10-22T01:00:02Z',
    data: { xray: 'reconfigured' },
  }
  f.client.events = async () => response([event], '18')
  await f.service.pollEvents()
  assert.equal(f.service.view(VM).state, 'applied')
  assert.equal(f.env.marker, null)
  const current = { ...event, event_id: 'ev_19', entity_id: 'px_2' }
  f.client.events = async () => response([current], '19')
  await f.service.pollEvents()
  assert.equal(f.service.view(VM).state, 'pending')
  assert.equal(f.service.view(VM).error.code, 'CREDENTIAL_ROTATED')
  await f.service.execute(VM, 'apply')
  await f.service.pollEvents()
  assert.equal(f.service.view(VM).state, 'applied')
  const failed = {
    ...current,
    event_id: 'ev_20',
    type: 'proxy.health_changed',
    data: { status: 'unreachable', error: SECRET },
  }
  f.client.events = async () => response([failed], '20')
  await f.service.pollEvents()
  assert.equal(f.service.view(VM).error.code, 'PROXY_UNHEALTHY')
  assert.equal(JSON.stringify(f.service.view(VM)).includes(SECRET), false)
})

test('snapshot health failure holds a slot even when the assignment version and exit have not changed', async (t) => {
  const f = await fixture(t)
  await f.service.execute(VM, 'assign')
  f.env.assignment.current_proxy = { health: { status: 'suspect', checked_at: '2026-10-22T01:00:10Z', error: SECRET } }
  const accessCount = calls(f, 'access').length
  await f.service.pollEvents()
  assert.equal(f.service.view(VM).state, 'pending')
  assert.equal(f.service.view(VM).error.code, 'PROXY_UNHEALTHY')
  assert.equal(calls(f, 'access').length, accessCount)
  assert.ok(f.env.marker)
})

test('probe and login actions cannot bypass an unfinished settle after the new exit was verified', async (t) => {
  const f = await fixture(t)
  const settle = f.client.settle
  f.client.settle = async () => {
    throw new IpPoolError('NETWORK_ERROR', { outcomeUnknown: true })
  }
  const pending = await f.service.execute(VM, 'assign')
  assert.equal(pending.state, 'pending')
  assert.equal(pending.applied.exit_ip, FIRST)
  assert.equal(loadIpPoolState(f.stateFile).vms[VM].previous.length, 0)
  const verifications = calls(f, 'verify').length
  for (const action of ['probe', 'login-lock', 'login-unlock']) {
    const result = await f.service.execute(VM, action)
    assert.equal(result.error.code, 'RECONCILE_REQUIRED')
    assert.ok(f.env.marker)
  }
  await assert.rejects(f.service.execute(VM, 'access'), { code: 'RECONCILE_REQUIRED' })
  assert.equal(calls(f, 'verify').length, verifications)
  assert.equal(calls(f, 'restore').length, 0)
  f.client.settle = settle
  assert.equal((await f.service.execute(VM, 'apply')).state, 'applied')
  assert.equal(f.env.marker, null)
})
