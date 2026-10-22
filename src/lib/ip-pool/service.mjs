import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { IpPoolError } from './client.mjs'
import { loadIpPoolState, saveIpPoolState } from './state.mjs'

const MESSAGES = {
  INVALID_ACTION: '不支持此 IP 管理操作。',
  INVALID_VM: '账号槽位编号不正确。',
  INVALID_TARGET_EXIT_IP: '请输入有效的公网 IP 地址，不要填写链接、域名或端口。',
  TARGET_EXIT_IP_MISMATCH: '上游分配与指定公网 IP 不一致，保持暂停，请核查 IP 池。',
  EXACT_EXIT_UNSUPPORTED: 'IP 池尚未支持指定公网 IP，请先更新 IP 池。',
  BUSY: '此账号正在处理 IP 操作，请等待完成。',
  LOGIN_LOCKED: '登录期间已锁定出口，请先完成登录并解除锁定。',
  BLACKLISTED: '此账号已确认封禁，保持停用。',
  BAN_EVIDENCE_REQUIRED: '标黑需要确认封禁、事件编号和已核验的事件出口。',
  ASSIGNMENT_MISSING: '未找到此账号的分配，请执行分配操作。',
  ASSIGNMENT_CHANGED: '上游分配已变化，已暂停账号，请应用并核验当前分配。',
  PROXY_UNHEALTHY: '当前出口健康检查失败，已暂停账号，请检查代理。',
  CREDENTIAL_ROTATED: '当前代理凭据已轮换，已暂停账号，请重新应用连接资料。',
  ASSIGNMENT_INACTIVE: '上游分配已暂停，需人工检查后换绑。',
  RECONCILE_REQUIRED: '上次操作结果待核对，请先应用当前分配，不能再次换绑。',
  DRAIN_FAILED: '账号仍有请求在途，保持暂停。',
  EXIT_IP_MISMATCH: '实际出口与分配不一致，保持暂停。',
  PROBE_FAILED: '无法核验实际出口，保持暂停。',
  TIMEZONE_LOOKUP_FAILED: '无法确定分配出口的时区，保持暂停，请稍后核对后应用。',
  TIMEZONE_RUNTIME_FAILED: '槽位实际时区未能同步，保持暂停，请核对后应用。',
  SLOT_NOT_RUNNING: '槽位尚未运行，保持暂停，启动后再应用并核验。',
  RESTORE_FAILED: '未能解除本次维护标记，账号继续暂停。',
  CLEANUP_FAILED: '旧代理连接尚未确认结束，账号继续暂停。',
  ACCESS_MISMATCH: '连接资料与当前分配不一致，保持暂停。',
  BLACKLIST_MISSING: '标黑结果尚未查到，请核查后重试删除。',
  INTERRUPTED: '上次操作被中断，保持暂停，请应用当前分配完成对账。',
  STATE_UNAVAILABLE: '无法读写 IP 池本地状态。',
  RUNTIME_UNSUPPORTED: '当前槽位不支持 IP 池连接。',
  OPERATION_FAILED: 'IP 操作未完成，账号保持暂停，请检查后人工处理。',
  CLOSED: 'IP 池服务已停止。',
}

function failure(code, status = 409) {
  return Object.assign(new Error(MESSAGES[code] || MESSAGES.OPERATION_FAILED), { code, status })
}

function safeError(error) {
  if (error instanceof IpPoolError) return { code: error.code, message: error.message }
  const aliases = {
    exit_ip_mismatch: 'EXIT_IP_MISMATCH',
    slot_not_running: 'SLOT_NOT_RUNNING',
    slot_exit_probe_failed: 'PROBE_FAILED',
    slot_exit_invalid: 'PROBE_FAILED',
    ip_pool_runtime_unsupported: 'RUNTIME_UNSUPPORTED',
    ip_pool_linux_required: 'RUNTIME_UNSUPPORTED',
    ip_pool_operation_busy: 'BUSY',
    ip_pool_operation_mismatch: 'RESTORE_FAILED',
  }
  const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : aliases[error?.code] || 'OPERATION_FAILED'
  return { code, message: MESSAGES[code] }
}

const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const now = () => new Date().toISOString()

function canonicalIp(value) {
  if (typeof value !== 'string' || !isIP(value.trim())) throw failure('INVALID_TARGET_EXIT_IP', 400)
  const ip = value.trim()
  return isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip
}

function select(source, fields) {
  if (!source) return null
  return Object.fromEntries(fields.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]))
}

function assignmentRecord(value) {
  if (!value || typeof value.assignment_id !== 'string' || !Number.isInteger(value.version)) {
    throw failure('ASSIGNMENT_MISSING')
  }
  const result = select(value, [
    'assignment_id',
    'version',
    'state',
    'hold',
    'current_exit_ip',
    'current_proxy_id',
    'consumer_ref',
    'distance_km_from_anchor',
  ])
  result.policy = select(value.policy, [
    'exclusive_exit',
    'protocols',
    'same_country_required',
    'settle_grace_seconds',
    'country_code',
    'max_distance_km',
    'min_quality_score',
    'network_types',
    'max_health_age_seconds',
    'address_family',
  ])
  result.anchor = select(value.anchor, [
    'exit_ip',
    'ip',
    'country_code',
    'country',
    'region',
    'city',
    'latitude',
    'longitude',
    'source',
    'fixed_at',
  ])
  result.current_health = select(value.current_proxy?.health, ['status', 'checked_at', 'last_ok_at'])
  result.proxy_missing = Object.hasOwn(value, 'current_proxy') && value.current_proxy === null
  return result
}

function captureRecord(value, vmId) {
  const proxy = select(value?.proxy, ['id', 'scheme', 'kind'])
  if (proxy && value.proxy.host === 'local') proxy.host = 'local'
  return { vmId, proxy, running: value?.running === true }
}

function runtimeRecord(value) {
  return select(value, ['container', 'name', 'vmId', 'assignmentId', 'port', 'createdAt'])
}

function blacklistRecord(value) {
  const record = select(value, [
    'blacklist_id',
    'canonical_exit_ip',
    'deletion_state',
    'allocation_blocked',
    'inventory_removed',
    'endpoint_access_revoked',
    'retryable',
    'deleted_at',
    'removed_proxy_count',
  ])
  if (!record) return null
  record.removed_proxies = (value.removed_proxies || []).map((item) => select(item, ['proxy_id', 'exit_ip', 'deleted']))
  record.last_sync_error = value.last_sync_error ? '上游删除尚未完成。' : null
  return record
}

function checked(result, fallback) {
  if (result?.ok !== true)
    throw failure(
      Object.hasOwn(MESSAGES, result?.code)
        ? result.code
        : {
            exit_ip_mismatch: 'EXIT_IP_MISMATCH',
            slot_not_running: 'SLOT_NOT_RUNNING',
          }[result?.code] || fallback,
    )
  return result
}

export function createIpPoolService({ client, adapter, runtime, stateFile, instanceId, pollIntervalMs = 30000 }) {
  if (!client || !adapter || !runtime || !stateFile || !instanceId) throw failure('OPERATION_FAILED', 500)
  const data = loadIpPoolState(stateFile)
  const active = new Set()
  let polling = null
  let closed = false
  const save = () => saveIpPoolState(stateFile, data)

  let recovered = false
  for (const entry of Object.values(data.vms)) {
    if (entry.operation) {
      entry.maintenance_id ||= entry.operation.id
      entry.operation = null
      entry.state = entry.ban_confirmed ? 'blacklisted' : 'pending'
      entry.error = safeError(failure('INTERRUPTED'))
      recovered = true
    }
  }
  if (recovered) save()

  function entryFor(vmId, create = false) {
    if (typeof vmId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(vmId)) throw failure('INVALID_VM', 400)
    if (!Object.hasOwn(data.vms, vmId) && create) {
      data.vms[vmId] = {
        vm_id: vmId,
        state: 'unassigned',
        assignment: null,
        applied: null,
        staged: null,
        capture: null,
        previous: [],
        maintenance_id: null,
        login_locked: false,
        ban_confirmed: false,
        history: [],
        blacklist: null,
        operation: null,
        pending_mutation: null,
        error: null,
      }
    }
    return Object.hasOwn(data.vms, vmId) ? data.vms[vmId] : null
  }

  function view(vmId) {
    const entry = entryFor(vmId)
    return copy({
      configured: true,
      vm_id: vmId,
      state: entry?.state || 'unassigned',
      assignment: entry?.assignment
        ? select(entry.assignment, [
            'assignment_id',
            'version',
            'state',
            'current_exit_ip',
            'anchor',
            'distance_km_from_anchor',
            'consumer_ref',
          ])
        : null,
      applied: entry?.applied
        ? select(entry.applied, ['exit_ip', 'verified_at', 'assignment_version', 'proxy_id'])
        : null,
      login_locked: entry?.login_locked === true,
      error: entry?.error || (entry ? data.poll_error : null) || null,
      blacklist: entry?.blacklist || null,
      operation: entry?.operation || null,
    })
  }

  function isManaged(vmId) {
    const entry = entryFor(vmId)
    return !!entry && (entry.state !== 'released' || !!entry.maintenance_id || entry.ban_confirmed)
  }

  function retiredBan(entry) {
    return !!(
      entry?.ban_confirmed &&
      entry.state === 'blacklisted' &&
      entry.assignment?.state === 'released' &&
      entry.blacklist?.deletion_state === 'succeeded' &&
      entry.blacklist.endpoint_access_revoked === true &&
      entry.blacklist.inventory_removed === true &&
      !entry.applied &&
      !entry.staged &&
      !entry.previous?.length &&
      !entry.pending_mutation &&
      !entry.pending_apply &&
      !entry.pending_release &&
      !entry.operation &&
      !entry.login_locked &&
      (!entry.error || entry.error.code === 'ASSIGNMENT_CHANGED')
    )
  }

  async function canDelete(vmId) {
    if (!isManaged(vmId)) return true
    const entry = entryFor(vmId)
    if (active.has(vmId) || !retiredBan(entry)) return false
    try {
      // capture is the current binding; entry.capture is retained historical evidence.
      const current = await adapter.capture(vmId)
      return current?.vmId === vmId && current.proxy === null && !active.has(vmId) && retiredBan(entry)
    } catch {
      return false
    }
  }

  function isLocked(vmId) {
    const entry = entryFor(vmId)
    return entry?.login_locked === true || entry?.ban_confirmed === true
  }

  function phase(entry, value) {
    if (entry.operation) entry.operation.phase = value
    save()
  }

  async function holdAndDrain(entry) {
    const current = captureRecord(await adapter.capture(entry.vm_id), entry.vm_id)
    entry.capture ||= current
    entry.maintenance_id ||= entry.operation?.id || `ip-pool-${randomUUID()}`
    save()
    checked(await adapter.hold(entry.vm_id, entry.maintenance_id), 'OPERATION_FAILED')
    phase(entry, 'draining')
    checked(await adapter.drain(entry.vm_id), 'DRAIN_FAILED')
    return current
  }

  async function finishHold(entry) {
    if (entry.login_locked || entry.ban_confirmed) return
    checked(await adapter.restore(entry.vm_id, entry.maintenance_id), 'RESTORE_FAILED')
    entry.maintenance_id = null
    save()
  }

  function rememberPrevious(entry, snapshot) {
    if (!snapshot?.proxy?.id) return
    const matching = [entry.staged, entry.applied].find((item) => item?.proxy_id === snapshot.proxy.id)
    if (!entry.previous.some((item) => item.snapshot?.proxy?.id === snapshot.proxy.id)) {
      entry.previous.push({ snapshot, runtime: matching?.runtime || null })
      save()
    }
  }

  async function stopRuntime(bridge) {
    if (!bridge) return
    checked(await runtime.stop(bridge), 'CLEANUP_FAILED')
    const inspected = checked(await runtime.inspect(bridge), 'CLEANUP_FAILED')
    if (inspected.running) throw failure('CLEANUP_FAILED')
  }

  async function cleanPrevious(entry, keepRuntime = null, keepProxy = null) {
    for (const previous of [...entry.previous]) {
      if (previous.snapshot?.proxy?.id === keepProxy) {
        entry.previous = entry.previous.filter((item) => item !== previous)
        save()
        continue
      }
      checked(await adapter.stopOld(previous.snapshot), 'CLEANUP_FAILED')
      if (previous.runtime?.container !== keepRuntime?.container) await stopRuntime(previous.runtime)
      entry.previous = entry.previous.filter((item) => item !== previous)
      save()
    }
  }

  async function settle(entry) {
    if (!entry.assignment) return
    phase(entry, 'settling')
    const result = await client.settle(entry.assignment.assignment_id)
    if ((result.skipped || []).length) throw failure('CLEANUP_FAILED')
  }

  async function mutate(entry, type, run) {
    entry.pending_mutation = { type, version: entry.assignment?.version ?? null, started_at: now() }
    save()
    try {
      const result = await run()
      entry.pending_mutation = null
      return result
    } catch (error) {
      if (!error?.outcomeUnknown) {
        entry.pending_mutation = null
        if (type === 'assign' || type === 'replace') delete entry.requested_exit_ip
      }
      throw error
    }
  }

  async function reconcile(entry) {
    let found
    if (entry.assignment?.assignment_id) {
      found = await client.getAssignment(entry.assignment.assignment_id)
    } else {
      const result = await client.listAssignments(`vm2api:${instanceId}:${entry.vm_id}`)
      if (!Array.isArray(result?.assignments)) throw new IpPoolError('INVALID_RESPONSE')
      found = result.assignments.find((item) => item.consumer_ref === `vm2api:${instanceId}:${entry.vm_id}`)
    }
    if (!found) {
      if (!entry.assignment && entry.pending_mutation?.type === 'assign') {
        entry.pending_mutation = null
        delete entry.requested_exit_ip
        save()
      }
      throw failure('ASSIGNMENT_MISSING')
    }
    entry.assignment = assignmentRecord(found)
    if (entry.pending_mutation?.type !== 'blacklist') entry.pending_mutation = null
    save()
    return entry.assignment
  }

  async function releaseLocal(entry) {
    entry.pending_release = true
    phase(entry, 'applying')
    const seen = new Set()
    for (const item of [entry.staged, entry.applied]) {
      if (item?.runtime && !seen.has(item.runtime.container)) {
        await stopRuntime(item.runtime)
        seen.add(item.runtime.container)
      }
    }
    checked(await adapter.detach(entry.vm_id), 'CLEANUP_FAILED')
    await cleanPrevious(entry)
    await settle(entry)
    entry.applied = null
    entry.staged = null
    entry.pending_mutation = null
    entry.login_locked = false
    await finishHold(entry)
    entry.pending_apply = false
    entry.pending_release = false
    delete entry.requested_exit_ip
    entry.state = entry.ban_confirmed ? 'blacklisted' : 'released'
  }

  async function applyAssignment(entry, before) {
    entry.pending_apply = true
    save()
    const assignment = entry.assignment
    if (assignment.state === 'released') return releaseLocal(entry)
    if (entry.requested_exit_ip && canonicalIp(assignment.current_exit_ip) !== entry.requested_exit_ip)
      throw failure('TARGET_EXIT_IP_MISMATCH')
    if (assignment.state !== 'active') throw failure('ASSIGNMENT_INACTIVE')
    const access = await client.access(assignment.assignment_id, assignment.version)
    if (
      access.assignment_id !== assignment.assignment_id ||
      access.version !== assignment.version ||
      access.expected_exit_ip !== assignment.current_exit_ip ||
      !isIP(String(access.expected_exit_ip || ''))
    ) {
      throw failure('ACCESS_MISMATCH')
    }
    rememberPrevious(entry, before)
    phase(entry, 'applying')
    const bridge = checked(
      await runtime.start({ vmId: entry.vm_id, assignmentId: assignment.assignment_id, access }),
      'OPERATION_FAILED',
    )
    const savedRuntime = runtimeRecord(bridge)
    if (entry.staged?.runtime && entry.staged.runtime.container !== savedRuntime.container) {
      if (entry.staged.proxy_id)
        rememberPrevious(entry, { vmId: entry.vm_id, proxy: { id: entry.staged.proxy_id }, running: true })
      else await stopRuntime(entry.staged.runtime)
    }
    entry.staged = {
      runtime: savedRuntime,
      exit_ip: access.expected_exit_ip,
      assignment_version: assignment.version,
      proxy_id: null,
    }
    save()
    const bound = checked(await adapter.apply(entry.vm_id, bridge, access.expected_exit_ip), 'OPERATION_FAILED')
    entry.staged.proxy_id = bound.proxy_id
    save()
    phase(entry, 'probing')
    const verified = checked(await adapter.verify(entry.vm_id, access.expected_exit_ip), 'PROBE_FAILED')
    if (verified.exit_ip !== access.expected_exit_ip) throw failure('EXIT_IP_MISMATCH')
    entry.applied = { ...entry.staged, exit_ip: verified.exit_ip, verified_at: verified.verified_at || now() }
    entry.staged = null
    entry.history.push({
      exit_ip: verified.exit_ip,
      verified_at: entry.applied.verified_at,
      assignment_version: assignment.version,
      assignment_id: assignment.assignment_id,
      proxy_id: assignment.current_proxy_id,
    })
    entry.history = entry.history.slice(-100)
    save()
    await cleanPrevious(entry, savedRuntime, bound.proxy_id)
    await settle(entry)
    await finishHold(entry)
    entry.pending_apply = false
    delete entry.requested_exit_ip
    entry.state = entry.login_locked ? 'login_locked' : 'applied'
  }

  async function verifyCurrent(entry, { allowErrorRetry = false } = {}) {
    if (
      entry.pending_mutation ||
      entry.requested_exit_ip ||
      entry.pending_apply ||
      entry.pending_release ||
      entry.previous.length ||
      entry.staged ||
      (!['applied', 'login_locked'].includes(entry.state) && !(allowErrorRetry && entry.state === 'error'))
    )
      throw failure('RECONCILE_REQUIRED')
    const previous = entry.assignment
    const current = await reconcile(entry)
    if (
      current.state !== 'active' ||
      current.version !== entry.applied?.assignment_version ||
      current.current_exit_ip !== entry.applied?.exit_ip ||
      current.assignment_id !== previous?.assignment_id
    ) {
      throw failure('ASSIGNMENT_CHANGED')
    }
    phase(entry, 'probing')
    const verified = checked(await adapter.verify(entry.vm_id, current.current_exit_ip), 'PROBE_FAILED')
    if (verified.exit_ip !== current.current_exit_ip) throw failure('EXIT_IP_MISMATCH')
    entry.applied.verified_at = verified.verified_at || now()
    save()
    return current
  }

  function banEvidence(entry, body) {
    const eventTime = Date.parse(body.occurred_at)
    const match = entry.history.find(
      (item) =>
        item.exit_ip === body.exit_ip_at_event &&
        (body.assignment_version_at_event === undefined ||
          item.assignment_version === body.assignment_version_at_event),
    )
    if (
      body.confirmation !== 'user_confirmed' ||
      typeof body.incident_id !== 'string' ||
      !body.incident_id.trim() ||
      !isIP(String(body.exit_ip_at_event || '')) ||
      !Number.isFinite(eventTime) ||
      !match
    ) {
      throw failure('BAN_EVIDENCE_REQUIRED', 400)
    }
    return {
      confirmation: 'user_confirmed',
      incident_id: body.incident_id.slice(0, 128),
      exit_ip_at_event: body.exit_ip_at_event,
      occurred_at: new Date(eventTime).toISOString(),
      reason: String(body.reason || 'account_banned').slice(0, 40),
      assignment_id: match.assignment_id,
      assignment_version_at_event: match.assignment_version,
      proxy_id_at_event: match.proxy_id,
    }
  }

  async function execute(vmId, action, body = {}) {
    if (closed) throw failure('CLOSED', 503)
    const actions = [
      'assign',
      'apply',
      'replace',
      'probe',
      'release',
      'login-lock',
      'login-unlock',
      'access',
      'blacklist',
      'retry-deletion',
    ]
    if (!actions.includes(action)) throw failure('INVALID_ACTION', 400)
    const target =
      ['assign', 'replace'].includes(action) && Object.hasOwn(body, 'target_exit_ip')
        ? canonicalIp(body.target_exit_ip)
        : null
    const entry = entryFor(vmId, true)
    if (active.has(vmId)) throw failure('BUSY')
    if (entry.ban_confirmed && ['assign', 'apply', 'replace', 'login-lock', 'login-unlock', 'access'].includes(action))
      throw failure('BLACKLISTED')
    if (entry.login_locked && ['assign', 'apply', 'replace', 'release'].includes(action)) throw failure('LOGIN_LOCKED')
    if (entry.requested_exit_ip && ['assign', 'replace'].includes(action)) throw failure('RECONCILE_REQUIRED')
    if (target) {
      if (entry.pending_mutation || entry.requested_exit_ip) throw failure('RECONCILE_REQUIRED')
      const capabilities = await client.capabilities()
      if (capabilities.features?.exact_exit_ip !== true) throw failure('EXACT_EXIT_UNSUPPORTED')
      // capabilities is read-only; recheck the per-VM lock after awaiting it.
      if (active.has(vmId)) throw failure('BUSY')
      if (entry.ban_confirmed) throw failure('BLACKLISTED')
      if (entry.login_locked) throw failure('LOGIN_LOCKED')
      if (entry.pending_mutation || entry.requested_exit_ip) throw failure('RECONCILE_REQUIRED')
    }
    const evidence = action === 'blacklist' ? banEvidence(entry, body) : null
    active.add(vmId)
    entry.operation = {
      id: entry.maintenance_id || `ip-pool-${randomUUID()}`,
      type: action,
      phase: 'running',
      started_at: now(),
    }
    entry.error = null
    if (evidence) {
      entry.ban_confirmed = true
      entry.ban_event = evidence
      entry.state = 'blacklisted'
    }
    // Finishing browser login releases only the login lock. Maintenance remains until verification or apply completes.
    if (action === 'login-unlock') entry.login_locked = false
    data.auth_paused = false
    save()
    let accessResult
    try {
      const before = await holdAndDrain(entry)
      if (action === 'assign') {
        if (entry.pending_mutation?.type === 'replace') throw failure('RECONCILE_REQUIRED')
        if (entry.assignment && entry.assignment.state !== 'released') {
          await reconcile(entry)
          if (target && canonicalIp(entry.assignment.current_exit_ip) !== target) {
            entry.requested_exit_ip = target
            save()
            throw failure('TARGET_EXIT_IP_MISMATCH')
          }
          if (target) {
            await verifyCurrent(entry)
            await finishHold(entry)
            entry.state = 'applied'
          } else await applyAssignment(entry, before)
        } else {
          if (target) entry.requested_exit_ip = target
          const result = await mutate(entry, 'assign', () =>
            client.assign({
              consumer_ref: `vm2api:${instanceId}:${vmId}`,
              ...(target ? { target_exit_ip: target } : {}),
              policy: {
                exclusive_exit: true,
                protocols: ['vless'],
                same_country_required: true,
                settle_grace_seconds: 900,
              },
            }),
          )
          entry.assignment = assignmentRecord(result.assignment)
          save()
          await applyAssignment(entry, before)
        }
      } else if (action === 'apply') {
        await reconcile(entry)
        await applyAssignment(entry, before)
      } else if (action === 'replace') {
        if (entry.pending_mutation) throw failure('RECONCILE_REQUIRED')
        const expected = entry.assignment?.version
        const found = await reconcile(entry)
        if (found.version !== expected) throw failure('ASSIGNMENT_CHANGED')
        if (!target || canonicalIp(found.current_exit_ip) !== target) {
          rememberPrevious(entry, before)
          if (target) entry.requested_exit_ip = target
          const result = await mutate(entry, 'replace', () =>
            client.replace(found.assignment_id, {
              expected_version: found.version,
              reason: String(body.reason || 'manual_replacement').slice(0, 80),
              require_new_exit_ip: true,
              ...(target ? { target_exit_ip: target } : {}),
            }),
          )
          entry.assignment = assignmentRecord(result.assignment)
          save()
          await applyAssignment(entry, before)
        } else {
          await verifyCurrent(entry)
          await finishHold(entry)
          entry.state = 'applied'
        }
      } else if (action === 'release') {
        if (entry.assignment || entry.pending_mutation) await reconcile(entry)
        if (entry.assignment?.state !== 'released' && entry.assignment) {
          const result = await mutate(entry, 'release', () =>
            client.release(entry.assignment.assignment_id, {
              expected_version: entry.assignment.version,
              reason: 'manual_release',
            }),
          )
          entry.assignment = assignmentRecord(result.assignment)
          save()
        }
        await releaseLocal(entry)
      } else if (action === 'probe' || action === 'login-unlock') {
        await verifyCurrent(entry, { allowErrorRetry: action === 'login-unlock' })
        await finishHold(entry)
        entry.state = entry.ban_confirmed ? 'blacklisted' : entry.login_locked ? 'login_locked' : 'applied'
      } else if (action === 'login-lock' || action === 'access') {
        await verifyCurrent(entry)
        entry.login_locked = true
        entry.state = 'login_locked'
        save()
        if (action === 'access') {
          const connection = await client.access(entry.assignment.assignment_id, entry.assignment.version)
          if (
            connection.expected_exit_ip !== entry.applied.exit_ip ||
            connection.version !== entry.assignment.version ||
            typeof connection.uri !== 'string' ||
            !connection.uri.startsWith('vless://')
          )
            throw failure('ACCESS_MISMATCH')
          accessResult = { uri: connection.uri, expected_exit_ip: connection.expected_exit_ip }
        }
      } else if (action === 'blacklist') {
        for (const item of [entry.staged, entry.applied, ...entry.previous])
          if (item?.runtime) await stopRuntime(item.runtime)
        const result = await mutate(entry, 'blacklist', () => client.blacklist(evidence))
        entry.blacklist = blacklistRecord(result)
      } else if (action === 'retry-deletion') {
        if (!entry.ban_confirmed) throw failure('BLACKLIST_MISSING')
        for (const item of [entry.staged, entry.applied, ...entry.previous])
          if (item?.runtime) await stopRuntime(item.runtime)
        let replayed = false
        if (!entry.blacklist?.blacklist_id) {
          const result = await client.request(
            'GET',
            `/blacklist?${new URLSearchParams({ exit_ip: entry.ban_event.exit_ip_at_event })}`,
          )
          const found = result.data.blacklist?.find(
            (item) => item.canonical_exit_ip === entry.ban_event.exit_ip_at_event,
          )
          if (found) entry.blacklist = blacklistRecord(found)
          else {
            // This is an explicit retry using the same confirmed incident, never a new inferred ban.
            entry.blacklist = blacklistRecord(await mutate(entry, 'blacklist', () => client.blacklist(entry.ban_event)))
            replayed = true
          }
        }
        if (!replayed) entry.blacklist = blacklistRecord(await client.retryDeletion(entry.blacklist.blacklist_id))
        entry.pending_mutation = null
        entry.state = 'blacklisted'
      }
      entry.error = null
      data.poll_error = null
    } catch (error) {
      entry.error = safeError(error)
      entry.state = entry.ban_confirmed
        ? 'blacklisted'
        : error?.outcomeUnknown ||
            entry.pending_mutation ||
            ['ASSIGNMENT_CHANGED', 'RECONCILE_REQUIRED', 'INTERRUPTED'].includes(entry.error.code)
          ? 'pending'
          : 'error'
      if (error?.status === 401) data.auth_paused = true
    } finally {
      entry.operation = null
      try {
        save()
      } finally {
        active.delete(vmId)
      }
    }
    if (action === 'access' && !accessResult) throw failure(entry.error?.code || 'OPERATION_FAILED')
    return accessResult || view(vmId)
  }

  function eventHoldReason(entry, assignment, event) {
    const occurred = Date.parse(event.occurred_at)
    const verified = Date.parse(entry.applied?.verified_at)
    // Events have second precision; ignore only events definitely older than the last actual verification.
    if (Number.isFinite(occurred) && Number.isFinite(verified) && occurred + 1000 <= verified) return null
    const proxyMatches = event.entity_id === assignment.current_proxy_id
    const assignmentMatches = event.entity_id === assignment.assignment_id
    if (assignmentMatches && Number.isInteger(event.entity_version) && event.entity_version < assignment.version)
      return null
    if (proxyMatches && event.type === 'proxy.health_changed' && event.data?.status === 'unreachable')
      return 'PROXY_UNHEALTHY'
    if (proxyMatches && event.type === 'proxy.credential_rotated') return 'CREDENTIAL_ROTATED'
    if (proxyMatches && ['proxy.egress_changed', 'proxy.removed'].includes(event.type)) return 'ASSIGNMENT_CHANGED'
    if (assignmentMatches && ['assignment.paused', 'assignment.egress_changed'].includes(event.type))
      return 'ASSIGNMENT_CHANGED'
    if (
      assignmentMatches &&
      ['assignment.replaced', 'assignment.released'].includes(event.type) &&
      Number(event.entity_version) > Number(entry.applied?.assignment_version || 0)
    )
      return 'ASSIGNMENT_CHANGED'
    if (event.type === 'egress.blacklisted' && event.data?.exit_ip === assignment.current_exit_ip)
      return 'ASSIGNMENT_CHANGED'
    return null
  }

  async function reconcileForPoll(entry, events = []) {
    const vmId = entry.vm_id
    if (active.has(vmId)) return false
    // Keep the ban and its audit record after local removal, without trying to hold a deleted VM.
    if (retiredBan(entry)) return true
    if (!entry.assignment) return true
    active.add(vmId)
    try {
      if (entry.maintenance_id) checked(await adapter.hold(vmId, entry.maintenance_id), 'OPERATION_FAILED')
      const latest = assignmentRecord(await client.getAssignment(entry.assignment.assignment_id))
      const changed =
        latest.version !== entry.assignment.version ||
        latest.state !== entry.assignment.state ||
        latest.current_exit_ip !== entry.assignment.current_exit_ip
      const eventReason = events.map((event) => eventHoldReason(entry, latest, event)).find(Boolean)
      const healthFailed = ['suspect', 'unreachable'].includes(latest.current_health?.status)
      if (changed || latest.state !== 'active' || latest.proxy_missing || healthFailed || eventReason) {
        entry.maintenance_id ||= `ip-pool-${randomUUID()}`
        save()
        checked(await adapter.hold(vmId, entry.maintenance_id), 'OPERATION_FAILED')
        entry.assignment = latest
        entry.state = entry.ban_confirmed ? 'blacklisted' : 'pending'
        entry.error = safeError(failure(eventReason || (healthFailed ? 'PROXY_UNHEALTHY' : 'ASSIGNMENT_CHANGED')))
        save()
      }
      if (entry.blacklist?.blacklist_id)
        entry.blacklist = blacklistRecord(await client.getBlacklist(entry.blacklist.blacklist_id))
      return true
    } finally {
      active.delete(vmId)
    }
  }

  async function pollInner() {
    if (closed || data.auth_paused) return { skipped: true }
    try {
      let page
      try {
        page = await client.events(data.event_cursor || '0')
      } catch (error) {
        if (error?.code !== 'CURSOR_EXPIRED') throw error
        for (const entry of Object.values(data.vms)) {
          if (isManaged(entry.vm_id) && !(await reconcileForPoll(entry)))
            return { ok: true, deferred: true, cursor: data.event_cursor }
        }
        data.event_cursor = '0'
        save()
        page = await client.events('0')
      }
      const processed = new Set(data.processed_event_ids || [])
      const events = (page.data?.events || []).filter(
        (event) => /^ev_[0-9]+$/.test(event.event_id) && !processed.has(event.event_id),
      )
      for (const entry of Object.values(data.vms)) {
        if (isManaged(entry.vm_id) && !(await reconcileForPoll(entry, events)))
          return { ok: true, deferred: true, cursor: data.event_cursor }
      }
      data.processed_event_ids = [...new Set([...processed, ...events.map((event) => event.event_id)])].slice(-1000)
      if (page.next_cursor !== undefined) data.event_cursor = String(page.next_cursor)
      data.poll_error = null
      save()
      return { ok: true, cursor: data.event_cursor }
    } catch (error) {
      if (error?.status === 401) data.auth_paused = true
      data.poll_error = safeError(error)
      save()
      return { ok: false, error: data.poll_error, auth_paused: data.auth_paused === true }
    }
  }

  function pollEvents() {
    if (!polling)
      polling = pollInner().finally(() => {
        polling = null
      })
    return polling
  }

  const interval =
    pollIntervalMs > 0
      ? setInterval(
          () => {
            void pollEvents().catch(() => {})
          },
          Math.max(1000, pollIntervalMs),
        )
      : null
  interval?.unref?.()
  return {
    view,
    execute,
    isManaged,
    canDelete,
    isLocked,
    busy: (vmId) => active.has(vmId),
    pollEvents,
    close() {
      closed = true
      if (interval) clearInterval(interval)
    },
  }
}
