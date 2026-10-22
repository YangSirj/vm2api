import fs from 'node:fs'
import path from 'node:path'
import { IpPoolClient } from './client.mjs'
import { createIpPoolService } from './service.mjs'
import { createVmAdapter } from './vm-adapter.mjs'
import { createXrayRuntime } from './xray-runtime.mjs'
import { panelIdentity } from '../admin/panel-acl.mjs'

const ACTIONS = new Set([
  'assign',
  'apply',
  'access',
  'replace',
  'probe',
  'release',
  'login-lock',
  'login-unlock',
  'blacklist',
  'retry-deletion',
])

function denied(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status })
}

/** This small hook is the only panel-router dependency of the integration. */
export function createIpPoolPanel(ctx, { env = process.env } = {}) {
  const bodies = new WeakMap()
  let service = ctx.ipPoolService || null
  let setupError = false
  const enabled = !!(env.KIN_IP_POOL_URL && env.KIN_IP_POOL_KEY_FILE)
  if (!service && enabled) {
    try {
      fs.accessSync(env.KIN_IP_POOL_KEY_FILE, fs.constants.R_OK)
      const projectRoot = ctx.cfg.paths.project
      service = createIpPoolService({
        client: new IpPoolClient({ baseUrl: env.KIN_IP_POOL_URL, keyFile: env.KIN_IP_POOL_KEY_FILE }),
        adapter: createVmAdapter({
          projectRoot,
          proxyPool: ctx.proxyPool,
          getScheduler: () => ctx.poolScheduler,
          getMonitors: () => [ctx.usageProbeMonitor, ctx.credentialRefreshMonitor].filter(Boolean),
          routingConfig: () => ctx.routingConfig,
        }),
        runtime: createXrayRuntime({ projectRoot }),
        stateFile: path.join(ctx.cfg.paths.data || path.join(projectRoot, 'data'), 'ip-pool', 'state.json'),
        instanceId: env.KIN_IP_POOL_INSTANCE || 'local',
      })
    } catch {
      setupError = true
    }
  }

  // A legacy bind request needs its target checked before it reaches the old
  // route. Cache only bodies read here, so that route can consume the same body.
  async function readBody(req, limit) {
    if (bodies.has(req)) return bodies.get(req)
    return ctx.readBody(req, limit)
  }
  async function peekBody(req) {
    if (!bodies.has(req)) bodies.set(req, await ctx.readBody(req, 256 * 1024))
    return bodies.get(req)
  }

  function assertUnmanaged(vmId) {
    if (vmId && service?.isManaged(String(vmId))) {
      throw denied('ip_pool_managed', '这个账号由 IP 池管理，请在 IP 池卡片里更换或释放出口。')
    }
  }

  async function guardLegacy(req, pathname) {
    if (!service) return
    const vmPath = pathname.match(/^\/api\/panel\/vms\/([^/]+)(?:\/(.*))?$/)
    if (vmPath && service.isManaged(vmPath[1])) {
      const vmId = vmPath[1]
      const action = vmPath[2] || ''
      const view = service.view(vmId)
      if (req.method === 'GET') return
      if (service.busy(vmId)) throw denied('ip_pool_busy', '出口正在处理，请稍后再操作。')
      if (!action && req.method === 'DELETE' && (await service.canDelete?.(vmId))) return
      if (
        action === 'allocate-proxy' ||
        (!action && req.method === 'DELETE') ||
        ['reset', 'recreate', 'package'].includes(action)
      )
        assertUnmanaged(vmId)
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await peekBody(req) : {}
      if (body?.proxy_id || body?.proxy || body?.auto_allocate_proxy) assertUnmanaged(vmId)
      if (action === 'oauth/generate-auth-url') {
        const locked = await service.execute(vmId, 'login-lock', {})
        if (locked.error) throw denied(locked.error.code, locked.error.message)
        return
      }
      if (action.startsWith('oauth/')) {
        if (view.state !== 'login_locked') {
          throw denied('ip_pool_login_lock_required', '请先在 IP 池卡片点击“开始登录”，锁定出口后再授权。')
        }
        return
      }
      // Starting a stopped slot is needed before its actual exit can be checked.
      // The persisted maintenance gate still blocks new inference requests.
      if (action === 'start' || action === 'stop') return
      if (view.state !== 'applied') {
        throw denied('ip_pool_maintenance', '账号出口已暂停，请先完成登录或在 IP 池卡片核对后应用。')
      }
    }
    if (req.method === 'GET' || !pathname.startsWith('/api/panel/proxies')) return
    const match = pathname.match(/^\/api\/panel\/proxies\/([^/]+)(?:\/(.*))?$/)
    if (match && !['probe', 'geo', 'reveal'].includes(match[2] || '')) {
      const proxy = ctx.proxyPool?.snapshot().proxies.find((item) => item.id === match[1])
      for (const id of proxy?.bound_vm_ids || (proxy?.bound_vm_id ? [proxy.bound_vm_id] : [])) assertUnmanaged(id)
    }
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const body = await peekBody(req)
      assertUnmanaged(body?.vm_id || body?.bind_vm_id)
    }
  }

  async function handle(req, res, pathname) {
    const own = pathname.startsWith('/api/panel/ip-pool/')
    try {
      if (!own) {
        await guardLegacy(req, pathname)
        return false
      }
      res.setHeader('Cache-Control', 'no-store')
      if (panelIdentity(req).role !== 'admin') throw denied('forbidden', '只有管理员可以管理 IP 池。', 403)
      const match = pathname.match(/^\/api\/panel\/ip-pool\/vms\/([A-Za-z0-9][A-Za-z0-9_-]{0,80})(?:\/([a-z-]+))?$/)
      if (!match) throw denied('not_found', '接口不存在。', 404)
      const [, vmId, action] = match
      if (!service) {
        if (req.method !== 'GET' || action)
          throw denied('ip_pool_not_configured', 'IP 池尚未配置或授权文件不可用。', 503)
        ctx.json(res, 200, {
          ok: true,
          data: {
            configured: false,
            vm_id: vmId,
            state: 'unassigned',
            ...(setupError
              ? { error: { code: 'ip_pool_configuration', message: 'IP 池配置不可用，请检查服务器配置。' } }
              : {}),
          },
        })
        return true
      }
      if (req.method === 'GET' && !action) {
        ctx.json(res, 200, { ok: true, data: service.view(vmId) })
        return true
      }
      if (req.method !== 'POST' || !ACTIONS.has(action)) throw denied('not_found', '接口不存在。', 404)
      const body = await readBody(req, 16 * 1024)
      const result = await service.execute(vmId, action, body || {})
      ctx.json(res, 200, { ok: true, data: result })
      return true
    } catch (error) {
      const safe = /^[A-Za-z0-9_]+$/.test(error?.code || '')
      ctx.json(res, Number(error?.status) >= 400 && Number(error?.status) < 600 ? error.status : 409, {
        ok: false,
        error: {
          code: safe ? error.code : 'ip_pool_failed',
          message: safe ? error.message : 'IP 池操作失败，请核对当前状态后再继续。',
        },
      })
      return true
    }
  }
  return { handle, readBody, close: () => service?.close() }
}
