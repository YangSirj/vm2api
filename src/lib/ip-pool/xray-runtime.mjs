import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { toHostPath } from '../vm/host-path.mjs'
import { atomicWriteJson } from '../vm/vm-file.mjs'

const exec = promisify(execFile)
const LABEL = 'vm2api.ip-pool'
const PREFIX = 'vm2api-ip-pool-'
const failure = (code) => Object.assign(new Error(code), { code })

async function runDocker(args) {
  try {
    const { stdout } = await exec('docker', args, { timeout: 30000, maxBuffer: 1024 * 1024 })
    return { ok: true, stdout: String(stdout).trim() }
  } catch (error) {
    return { ok: false, missing: /No such (object|container)/i.test(String(error.stderr || '')) }
  }
}

export function parseVlessAccess(access) {
  const fields = access?.fields
  if (access?.protocol !== 'vless' || !fields || !fields.server || !fields.port) throw failure('invalid_vless_access')
  const uuid = String(fields.uuid || '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) throw failure('invalid_vless_uuid')
  if (fields.network !== 'tcp' || fields.security !== 'none' || fields.encryption !== 'none' || fields.flow) {
    throw failure('unsupported_vless_transport')
  }
  const host = String(fields.server)
  if (!host || /[\s/\\@]/.test(host)) throw failure('invalid_vless_server')
  const port = Number(fields.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure('invalid_vless_port')
  return { host: host.replace(/^\[|\]$/g, ''), port, uuid }
}

export function xrayConfig(upstream, port) {
  return {
    log: { loglevel: 'warning' },
    inbounds: [{ listen: '127.0.0.1', port, protocol: 'socks', settings: { auth: 'noauth', udp: false } }],
    outbounds: [
      {
        protocol: 'vless',
        settings: {
          vnext: [{ address: upstream.host, port: upstream.port, users: [{ id: upstream.uuid, encryption: 'none' }] }],
        },
        streamSettings: { network: 'tcp', security: 'none' },
      },
    ],
  }
}

function availablePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

function socksReady(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(500, () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])))
    socket.once('data', (data) => finish(data.length >= 2 && data[0] === 5 && data[1] === 0))
    socket.once('end', () => finish(false))
  })
}

/** One durable, independently stoppable VLESS bridge per assignment/credential. */
export function createXrayRuntime({ projectRoot, ops = {}, portStart = 24100, portEnd = 24999 } = {}) {
  const run = ops.runDocker || runDocker
  const runtimeRoot = path.join(projectRoot, 'data', 'ip-pool', 'runtime')
  const hostPath = ops.toHostPath || ((p) => toHostPath(p, { projectRoot }))
  const ready = ops.socksReady || socksReady
  const portFree = ops.portAvailable || availablePort
  let allocation = Promise.resolve()

  function owned(runtime) {
    const name = runtime?.container || runtime?.name
    if (typeof name !== 'string' || !new RegExp(`^${PREFIX}[0-9a-f]{20}$`).test(name))
      throw failure('invalid_bridge_runtime')
    return name
  }

  async function inspect(runtime) {
    const name = owned(runtime)
    const result = await run(['inspect', '--format', '{{json .}}', name])
    if (!result.ok)
      return result.missing ? { ok: true, exists: false, running: false } : { ok: false, code: 'bridge_inspect_failed' }
    let doc
    try {
      doc = JSON.parse(result.stdout)
    } catch {
      return { ok: false, code: 'bridge_inspect_failed' }
    }
    if (doc?.Config?.Labels?.[LABEL] !== 'true') return { ok: false, code: 'bridge_owner_mismatch' }
    return { ok: true, exists: true, running: doc.State?.Running === true, container: name }
  }

  async function waitReady(port) {
    const deadline = Date.now() + 5000
    do {
      if (await ready(port)) return true
      await new Promise((resolve) => setTimeout(resolve, 150))
    } while (Date.now() < deadline)
    return false
  }

  async function startInner({ vmId, assignmentId, access }) {
    if ((ops.platform || process.platform) !== 'linux') throw failure('ip_pool_linux_required')
    if (!vmId || !assignmentId) throw failure('assignment_required')
    const upstream = parseVlessAccess(access)
    const digest = crypto
      .createHash('sha256')
      .update(JSON.stringify([vmId, assignmentId, upstream]))
      .digest('hex')
      .slice(0, 20)
    const name = `${PREFIX}${digest}`
    const dir = path.join(runtimeRoot, name)
    const recordPath = path.join(dir, 'runtime.json')
    const existing = await inspect({ container: name })
    if (!existing.ok) throw failure(existing.code)
    if (existing.exists) {
      let saved
      try {
        saved = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
      } catch {
        throw failure('bridge_state_missing')
      }
      if (saved.vmId !== vmId || saved.assignmentId !== assignmentId || saved.container !== name)
        throw failure('bridge_state_mismatch')
      if (!existing.running && !(await run(['start', name])).ok) throw failure('bridge_start_failed')
      if (!(await waitReady(saved.port))) throw failure('bridge_not_ready')
      return { ...saved, ok: true, reused: true }
    }
    const binary = path.join(projectRoot, 'bin', 'xray')
    if (!fs.existsSync(binary)) throw failure('xray_binary_missing')
    const imageResult = await run(['inspect', '--format', '{{.Image}}', process.env.VM2API_CONTAINER_NAME || 'vm2api'])
    const image = String(imageResult.stdout || '').trim()
    if (!imageResult.ok || !/^(sha256:)?[0-9a-f]{12,64}$/.test(image)) throw failure('control_plane_image_unavailable')
    let port
    for (let candidate = portStart; candidate <= portEnd; candidate++) {
      if (await portFree(candidate)) {
        port = candidate
        break
      }
    }
    if (!port) throw failure('bridge_ports_exhausted')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const configPath = path.join(dir, 'xray.json')
    atomicWriteJson(configPath, xrayConfig(upstream, port), { mode: 0o600 })
    const runtime = {
      container: name,
      name,
      vmId,
      assignmentId,
      port,
      socksUrl: `socks5://127.0.0.1:${port}`,
      createdAt: new Date().toISOString(),
    }
    atomicWriteJson(recordPath, runtime, { mode: 0o600 })
    const started = await run([
      'run',
      '-d',
      '--name',
      name,
      '--network',
      'host',
      '--restart',
      'unless-stopped',
      '--label',
      `${LABEL}=true`,
      '--entrypoint',
      '/ip-pool/xray',
      '--mount',
      `type=bind,src=${hostPath(binary)},dst=/ip-pool/xray,readonly`,
      '--mount',
      `type=bind,src=${hostPath(configPath)},dst=/ip-pool/xray.json,readonly`,
      image,
      'run',
      '-config',
      '/ip-pool/xray.json',
    ])
    if (!started.ok) throw failure('bridge_start_failed')
    if (!(await waitReady(port))) {
      await run(['stop', '--time', '10', name])
      throw failure('bridge_not_ready')
    }
    return { ...runtime, ok: true, reused: false }
  }

  return {
    inspect,
    start(input) {
      const result = allocation.then(() => startInner(input))
      allocation = result.catch(() => {})
      return result
    },
    async stop(runtime) {
      const name = owned(runtime)
      const before = await inspect(runtime)
      if (!before.ok) return before
      if (before.running && !(await run(['stop', '--time', '10', name])).ok)
        return { ok: false, code: 'bridge_stop_failed' }
      const after = await inspect(runtime)
      if (!after.ok || after.running) return { ok: false, code: 'bridge_still_running' }
      if (after.exists && !(await run(['rm', name])).ok) return { ok: false, code: 'bridge_remove_failed' }
      return { ok: true, stopped: true, container: name }
    },
  }
}
