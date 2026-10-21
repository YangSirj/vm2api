import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createXrayRuntime, parseVlessAccess, xrayConfig } from '../../src/lib/ip-pool/xray-runtime.mjs'

const access = {
  protocol: 'vless',
  fields: {
    server: 'proxy.example.test',
    port: 56788,
    uuid: '11111111-2222-4333-8444-555555555555',
    network: 'tcp',
    security: 'none',
    encryption: 'none',
    flow: '',
  },
  uri: 'must-not-be-used',
}

function fixture(t, { busyPorts = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-pool-xray-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'bin'))
  fs.writeFileSync(path.join(root, 'bin', 'xray'), 'test fixture')
  const containers = new Map()
  const calls = []
  const ops = {
    platform: 'linux',
    toHostPath: (p) => `/host/${path.basename(p)}`,
    portAvailable: async (port) => !busyPorts.includes(port),
    socksReady: async () => true,
    runDocker: async (args) => {
      calls.push(args)
      const name = args.at(-1)
      if (args[0] === 'inspect' && args[2] === '{{.Image}}') return { ok: true, stdout: 'sha256:' + 'a'.repeat(64) }
      if (args[0] === 'inspect')
        return containers.has(name)
          ? {
              ok: true,
              stdout: JSON.stringify({
                Config: { Labels: { 'vm2api.ip-pool': 'true' } },
                State: { Running: containers.get(name) },
              }),
            }
          : { ok: false, missing: true }
      if (args[0] === 'run') containers.set(args[args.indexOf('--name') + 1], true)
      if (args[0] === 'stop') containers.set(name, false)
      if (args[0] === 'start') containers.set(name, true)
      if (args[0] === 'rm') containers.delete(name)
      return { ok: true, stdout: '' }
    },
  }
  return {
    root,
    calls,
    containers,
    ops,
    create: () => createXrayRuntime({ projectRoot: root, ops, portStart: 24100, portEnd: 24102 }),
  }
}

test('only documented fields produce a local SOCKS to VLESS TCP bridge', () => {
  const parsed = parseVlessAccess(access)
  const config = xrayConfig(parsed, 24100)
  assert.equal(config.inbounds[0].listen, '127.0.0.1')
  assert.equal(config.outbounds[0].settings.vnext[0].users[0].id, access.fields.uuid)
  assert.throws(() => parseVlessAccess({ ...access, fields: { ...access.fields, security: 'tls' } }), {
    code: 'unsupported_vless_transport',
  })
  assert.throws(() => parseVlessAccess({ uri: 'vless://unused' }), { code: 'invalid_vless_access' })
})

test('bridge uses private mounted config, existing control image and persists restart state', async (t) => {
  const f = fixture(t, { busyPorts: [24100] })
  const runtime = await f.create().start({ vmId: 'vm-01', assignmentId: 'a-1', access })
  assert.equal(runtime.port, 24101)
  assert.equal(JSON.stringify(runtime).includes(access.fields.uuid), false)
  const argv = f.calls.find((args) => args[0] === 'run')
  assert.equal(argv[argv.indexOf('--restart') + 1], 'unless-stopped')
  assert.equal(argv[argv.indexOf('--network') + 1], 'host')
  assert.equal(argv.includes('--entrypoint'), true)
  assert.equal(argv.includes('pull'), false)
  assert.equal(argv.join(' ').includes(access.fields.uuid), false)
  const config = JSON.parse(
    fs.readFileSync(path.join(f.root, 'data', 'ip-pool', 'runtime', runtime.container, 'xray.json')),
  )
  assert.equal(config.outbounds[0].settings.vnext[0].address, access.fields.server)
  const recovered = await f.create().start({ vmId: 'vm-01', assignmentId: 'a-1', access })
  assert.equal(recovered.reused, true)
  assert.equal(f.calls.filter((args) => args[0] === 'run').length, 1)
  assert.equal((await f.create().stop(recovered)).stopped, true)
  assert.equal(f.containers.size, 0)
})

test('new assignment has independent container and old bridge is left running', async (t) => {
  const f = fixture(t)
  const a = await f.create().start({ vmId: 'vm-01', assignmentId: 'a-1', access })
  f.ops.portAvailable = async (port) => port !== a.port
  const b = await f.create().start({ vmId: 'vm-01', assignmentId: 'a-2', access })
  assert.notEqual(a.container, b.container)
  assert.notEqual(a.port, b.port)
  assert.equal(f.containers.get(a.container), true)
  assert.equal(f.containers.get(b.container), true)
})

test('failed stop never reports disconnected and cannot target arbitrary containers', async (t) => {
  const f = fixture(t)
  const runtime = await f.create().start({ vmId: 'vm-01', assignmentId: 'a-1', access })
  const run = f.ops.runDocker
  f.ops.runDocker = async (args) => (args[0] === 'stop' ? { ok: false } : run(args))
  assert.deepEqual(await f.create().stop(runtime), { ok: false, code: 'bridge_stop_failed' })
  await assert.rejects(f.create().stop({ container: 'vm2api' }), { code: 'invalid_bridge_runtime' })
})
