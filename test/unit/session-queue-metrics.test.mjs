import test from 'node:test'
import assert from 'node:assert/strict'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

function fixture(config = {}) {
  const bindings = new Map([['session', { vmId: 'vm-01' }]])
  const stickyRouter = { resolve: (key) => bindings.get(key) }
  const scheduler = new PoolScheduler({ stickyRouter })
  const runner = new FailoverRunner({ scheduler, stickyRouter, config })
  const calls = []
  runner.runOnce = ({ requestId }) => {
    const job = deferred()
    calls.push({ requestId, ...job })
    return job.promise
  }
  return { scheduler, runner, bindings, calls }
}

test('session waits appear in the VM queue and leave it before starting execution', async () => {
  const { scheduler, runner, calls } = fixture()
  const frames = []
  scheduler.on('change', () => frames.push(scheduler.seatSnapshot()))
  const first = runner.run({ stickyKey: 'session', requestId: 'first' })
  await tick()
  assert.equal(scheduler.seatSnapshot().seats['vm-01'], undefined)
  const second = runner.run({ stickyKey: 'session', requestId: 'second' })
  const third = runner.run({ stickyKey: 'session', requestId: 'third' })
  const independent = runner.run({ stickyKey: 'other-session', requestId: 'independent' })
  await tick()
  assert.equal(calls.length, 2)
  assert.equal(scheduler.seatSnapshot().seats['vm-01'].queue_depth, 2)
  assert.equal(scheduler.seatSnapshot().seats['vm-01'].inflight, 0)
  // Showing session waits must not change the pool's admission limit.
  assert.equal(scheduler.queuedTotal(), 0)
  calls.find((c) => c.requestId === 'first').resolve({ ok: true })
  await first
  await tick()
  assert.equal(calls.at(-1).requestId, 'second')
  assert.equal(scheduler.seatSnapshot().seats['vm-01'].queue_depth, 1)
  calls.at(-1).resolve({ ok: true })
  await second
  await tick()
  assert.equal(calls.at(-1).requestId, 'third')
  assert.equal(scheduler.seatSnapshot().seats['vm-01'], undefined)
  calls.at(-1).resolve({ ok: true })
  calls.find((c) => c.requestId === 'independent').resolve({ ok: true })
  await Promise.all([third, independent])
  assert.equal(scheduler.sessionWaiters.size, 0)
  assert.deepEqual(
    frames.map((frame) => frame.seats['vm-01']?.queue_depth || 0),
    [1, 2, 1, 0],
  )
})

test('cancelled and timed-out session waits disappear without releasing the active turn', async (t) => {
  for (const kind of ['abort', 'timeout']) {
    await t.test(kind, async () => {
      const { scheduler, runner, calls } = fixture({ session_queue_timeout_ms: kind === 'timeout' ? 25 : 5000 })
      const first = runner.run({ stickyKey: 'session', requestId: 'first' })
      await tick()
      const controller = new AbortController()
      const waiting = runner.run({ stickyKey: 'session', requestId: 'waiting', signal: controller.signal })
      assert.equal(scheduler.seatSnapshot().seats['vm-01'].queue_depth, 1)
      if (kind === 'abort') controller.abort()
      const result = await waiting
      assert.equal(result.ok, false)
      if (kind === 'timeout') assert.equal(result.body.error.details.reason, 'session_queue_timeout')
      assert.equal(scheduler.sessionWaiters.size, 0)
      assert.equal(calls.length, 1)
      const next = runner.run({ stickyKey: 'session', requestId: 'next' })
      assert.equal(scheduler.seatSnapshot().seats['vm-01'].queue_depth, 1)
      calls[0].resolve({ ok: true })
      await first
      await tick()
      assert.equal(calls.at(-1).requestId, 'next')
      assert.equal(scheduler.sessionWaiters.size, 0)
      calls.at(-1).resolve({ ok: true })
      await next
    })
  }
})

test('session queue attribution follows VM binding and adds to existing pool queues', async () => {
  const { scheduler, runner, bindings, calls } = fixture()
  bindings.clear()
  const first = runner.run({ stickyKey: 'session', requestId: 'first' })
  await tick()
  const second = runner.run({ stickyKey: 'session', requestId: 'second' })
  assert.equal(scheduler.seatSnapshot().global_queue_depth, 1)
  bindings.set('session', { vmId: 'vm-01' })
  assert.equal(scheduler.seatSnapshot().global_queue_depth, 0)
  assert.equal(scheduler.seatSnapshot().seats['vm-01'].queue_depth, 1)
  bindings.set('session', { vmId: 'vm-02' })
  scheduler.waiters.set('account-2', new Map([['other-request', { vmId: 'vm-02' }]]))
  const snapshot = scheduler.seatSnapshot()
  assert.equal(snapshot.seats['vm-01'], undefined)
  assert.equal(snapshot.seats['vm-02'].queue_depth, 2)
  calls[0].resolve({ ok: true })
  await first
  await tick()
  assert.equal(scheduler.seatSnapshot().seats['vm-02'].queue_depth, 1)
  calls[1].resolve({ ok: true })
  await second
})
