import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IpPoolClient, IpPoolError } from '../../src/lib/ip-pool/client.mjs'

const BASE = 'https://pool.example:8443'
const TEST_KEY = 'xb_synthetic_test_key_not_a_credential'

async function fixture(t, fetchImpl, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vm2api-pool-client-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const keyFile = join(dir, 'key.txt')
  await writeFile(keyFile, TEST_KEY)
  return { client: new IpPoolClient({ baseUrl: BASE, keyFile, fetchImpl, ...options }), keyFile }
}

function reply(data, extra = {}, status = 200) {
  return new Response(JSON.stringify({ ok: true, request_id: 'req_test', data, ...extra }), { status })
}

test('pool wrappers send the documented paths, JSON bodies and safe HTTP options', async (t) => {
  const requests = []
  const { client } = await fixture(
    t,
    async (url, init) => {
      requests.push({ url, init })
      return reply({ accepted: true })
    },
    { baseUrl: `${BASE}/api/v1/` },
  )
  const steps = [
    [() => client.capabilities(), 'GET', '/capabilities'],
    [() => client.listAssignments('vm2api:account / 1'), 'GET', '/assignments?consumer_ref=vm2api%3Aaccount+%2F+1'],
    [() => client.getAssignment('asg_12'), 'GET', '/assignments/asg_12'],
    [
      () => client.candidates({ assignment_id: 'asg_12', limit: 50, exclude_proxy_ids: ['px_1'] }),
      'POST',
      '/candidates',
      { assignment_id: 'asg_12', limit: 50, exclude_proxy_ids: ['px_1'] },
    ],
    [
      () => client.assign({ consumer_ref: 'account-1', policy: { exclusive_exit: true } }),
      'POST',
      '/assignments',
      { consumer_ref: 'account-1', policy: { exclusive_exit: true } },
    ],
    [() => client.access('asg_12', 3), 'POST', '/assignments/asg_12/access', { expected_version: 3 }],
    [
      () => client.replace('asg_12', { expected_version: 3, reason: '连接失败' }),
      'POST',
      '/assignments/asg_12/replacements',
      { expected_version: 3, reason: '连接失败' },
    ],
    [() => client.settle('asg_12'), 'POST', '/assignments/asg_12/settle'],
    [
      () => client.release('asg_12', { expected_version: 4 }),
      'POST',
      '/assignments/asg_12/release',
      { expected_version: 4 },
    ],
    [
      () => client.blacklist({ confirmation: 'user_confirmed', exit_ip_at_event: '192.0.2.1' }),
      'POST',
      '/blacklist',
      { confirmation: 'user_confirmed', exit_ip_at_event: '192.0.2.1' },
    ],
    [() => client.getBlacklist('bl_9'), 'GET', '/blacklist/bl_9'],
    [() => client.retryDeletion('bl_9'), 'POST', '/blacklist/bl_9/retry-deletion'],
  ]
  for (const [run, method, path, body] of steps) {
    assert.deepEqual(await run(), { accepted: true })
    const actual = requests.at(-1)
    assert.equal(actual.url, `${BASE}/api/v1${path}`)
    assert.equal(actual.init.method, method)
    assert.equal(actual.init.headers.Authorization, `Bearer ${TEST_KEY}`)
    assert.equal(actual.init.headers['Content-Type'], 'application/json')
    assert.equal(actual.init.headers.Accept, 'application/json')
    assert.match(actual.init.headers['X-Request-ID'], /^req_[-0-9a-f]+$/)
    assert.equal(actual.init.redirect, 'error')
    assert.ok(actual.init.signal instanceof AbortSignal)
    assert.equal(actual.init.body, body === undefined ? undefined : JSON.stringify(body))
  }
  assert.equal(requests.length, steps.length)
})

test('request and events preserve the envelope cursor, including an empty events page', async (t) => {
  const requests = []
  const { client } = await fixture(t, async (url) => {
    requests.push(url)
    return reply({ events: [] }, { next_cursor: '90210' })
  })
  const result = await client.events('90209')
  assert.equal(requests[0], `${BASE}/api/v1/events?after=90209`)
  assert.deepEqual(result, { ok: true, request_id: 'req_test', data: { events: [] }, next_cursor: '90210' })
  assert.equal((await client.request('GET', '/events?after=0')).next_cursor, '90210')
})

test('key rotation is picked up on the next request without retaining the old key', async (t) => {
  const authorization = []
  const { client, keyFile } = await fixture(t, async (_, init) => {
    authorization.push(init.headers.Authorization)
    return reply({})
  })
  await client.capabilities()
  await writeFile(keyFile, '\uFEFF授权：xb_synthetic_rotated_key\n')
  await client.capabilities()
  assert.deepEqual(authorization, [`Bearer ${TEST_KEY}`, 'Bearer xb_synthetic_rotated_key'])
  assert.equal(JSON.stringify(client).includes(TEST_KEY), false)
})

test('409 version conflict preserves safe status and does not retry or expose the upstream message', async (t) => {
  let calls = 0
  const { client } = await fixture(t, async () => {
    calls += 1
    return new Response(
      JSON.stringify({
        ok: false,
        request_id: TEST_KEY,
        error: {
          code: 'VERSION_CONFLICT',
          message: `Bearer ${TEST_KEY}`,
          retryable: false,
          details: { token: TEST_KEY },
        },
      }),
      { status: 409 },
    )
  })
  await assert.rejects(client.replace('asg_1', { expected_version: 1 }), (error) => {
    assert.ok(error instanceof IpPoolError)
    assert.equal(error.code, 'VERSION_CONFLICT')
    assert.equal(error.status, 409)
    assert.equal(error.retryable, false)
    assert.equal(error.outcomeUnknown, false)
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(TEST_KEY), false)
    assert.equal(error.cause, undefined)
    return true
  })
  assert.equal(calls, 1)
})

test('a timeout aborts the request, marks a write result unknown and never retries it', async (t) => {
  let calls = 0
  let signal
  const { client } = await fixture(
    t,
    (_, init) => {
      calls += 1
      signal = init.signal
      return new Promise(() => {})
    },
    { timeoutMs: 15 },
  )
  await assert.rejects(client.replace('asg_1', { expected_version: 1 }), (error) => {
    assert.equal(error.code, 'TIMEOUT')
    assert.equal(error.status, 0)
    assert.equal(error.outcomeUnknown, true)
    assert.equal(error.retryable, false)
    return true
  })
  assert.equal(signal.aborted, true)
  assert.equal(calls, 1)
})

test('network failures and unknown upstream errors cannot echo credentials', async (t) => {
  const { client } = await fixture(t, async () => {
    throw new Error(`failed to connect: ${TEST_KEY} vless://synthetic-secret`)
  })
  await assert.rejects(client.assign({ consumer_ref: 'a' }), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR')
    assert.equal(error.outcomeUnknown, true)
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(TEST_KEY), false)
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes('vless://'), false)
    return true
  })
  const { client: unknown } = await fixture(
    t,
    async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: TEST_KEY, message: TEST_KEY, retryable: true },
        }),
        { status: 500 },
      ),
  )
  await assert.rejects(unknown.release('asg_1', { expected_version: 1 }), (error) => {
    assert.equal(error.code, 'UPSTREAM_ERROR')
    assert.equal(error.retryable, true)
    assert.equal(error.outcomeUnknown, true)
    assert.equal(JSON.stringify(error).includes(TEST_KEY), false)
    return true
  })
})

test('invalid responses are not treated as successful writes, and reads are not unknown mutations', async (t) => {
  const { client } = await fixture(t, async () => new Response('not json'))
  await assert.rejects(client.release('asg_1', { expected_version: 1 }), (error) => {
    assert.equal(error.code, 'INVALID_RESPONSE')
    assert.equal(error.outcomeUnknown, true)
    return true
  })
  await assert.rejects(client.capabilities(), (error) => {
    assert.equal(error.code, 'INVALID_RESPONSE')
    assert.equal(error.outcomeUnknown, false)
    return true
  })
})

test('candidate POST failures remain read-only for timeout, network, invalid response and upstream errors', async (t) => {
  const scenarios = [
    ['TIMEOUT', () => new Promise(() => {})],
    [
      'NETWORK_ERROR',
      async () => {
        throw new Error(TEST_KEY)
      },
    ],
    ['INVALID_RESPONSE', async () => new Response('not json')],
    ['INVALID_RESPONSE', async () => new Response(JSON.stringify({ data: [] }))],
    [
      'INTERNAL',
      async () =>
        new Response(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: TEST_KEY } }), { status: 500 }),
    ],
  ]
  for (const [code, respond] of scenarios) {
    let calls = 0
    const { client } = await fixture(
      t,
      (...args) => {
        calls += 1
        return respond(...args)
      },
      { timeoutMs: 15 },
    )
    await assert.rejects(client.candidates({ limit: 50 }), (error) => {
      assert.ok(error instanceof IpPoolError)
      assert.equal(error.code, code)
      assert.equal(error.outcomeUnknown, false)
      assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(TEST_KEY), false)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('invalid key files, non-HTTPS URLs and paths outside the API are rejected before sending', async (t) => {
  let calls = 0
  const { client, keyFile } = await fixture(t, async () => {
    calls += 1
    return reply({})
  })
  for (const baseUrl of ['http://pool.example', 'https://user:pass@pool.example', 'https://pool.example?key=secret']) {
    assert.throws(() => new IpPoolClient({ baseUrl, keyFile }), { code: 'CONFIGURATION_ERROR' })
  }
  for (const path of ['https://elsewhere.example', '//elsewhere.example', '/../outside', '/capabilities#fragment']) {
    await assert.rejects(client.request('GET', path), { code: 'INVALID_ARGUMENT' })
  }
  await writeFile(keyFile, 'xb_one xb_two')
  await assert.rejects(client.capabilities(), { code: 'KEY_UNAVAILABLE' })
  await rm(keyFile)
  await assert.rejects(client.capabilities(), { code: 'KEY_UNAVAILABLE' })
  assert.equal(calls, 0)
})
