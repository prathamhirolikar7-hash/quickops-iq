import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseRoute, routeHref } from "./routes.ts"
import { SimulatorRunner, type RunnerState, type RunnerTimers, type Scenario, type TickResult } from "./simulator-runner.ts"

class FakeTimers implements RunnerTimers {
  t = 0
  private seq = 0
  private tasks = new Map<number, { at: number; fn: () => void }>()
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq
    this.tasks.set(id, { at: this.t + ms, fn })
    return id
  }
  clearTimeout(h: unknown) {
    this.tasks.delete(h as number)
  }
  now() {
    return this.t
  }
  get pending() {
    return this.tasks.size
  }
  async advance(ms: number) {
    const end = this.t + ms
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)
      if (!due.length) break
      const [id, task] = due[0]
      this.tasks.delete(id)
      this.t = task.at
      task.fn()
      await flush()
    }
    this.t = end
  }
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}
class CodedError extends Error {
  code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}
const result = (over: Partial<TickResult> = {}): TickResult => ({
  created: 3, requested: 3, capped: false, steps_applied: 0, scenario: "normal", total_orders: 3, open_orders: 3,
  delivered_orders: 0, cancelled_orders: 0, created_today: 3, last_tick_at: null, max_open_orders: 500, max_total_orders: 20000, ...over,
})

function setup(tickImpl?: (s: Scenario, n: number) => Promise<TickResult>) {
  const timers = new FakeTimers()
  const calls: { s: Scenario; n: number }[] = []
  const states: RunnerState[] = []
  const errors: number[] = []
  const runner = new SimulatorRunner({
    timers,
    tick: tickImpl ?? (async (s, n) => (calls.push({ s, n }), result())),
    onState: (s) => states.push(s),
    onError: (_e, c) => errors.push(c),
    codeOf: (e) => (e instanceof CodedError ? e.code : undefined),
  })
  return { timers, calls, states, errors, runner }
}

describe("hash routes", () => {
  it("parses known routes and falls back to the overview", () => {
    assert.equal(parseRoute("#/orders"), "orders")
    assert.equal(parseRoute("#/simulator"), "simulator")
    assert.equal(parseRoute("#/Orders?x=1"), "orders")
    assert.equal(parseRoute(""), "overview")
    assert.equal(parseRoute("#/unknown"), "overview")
    assert.equal(routeHref("overview"), "#/")
    assert.equal(routeHref("orders"), "#/orders")
  })
})

describe("simulator runner", () => {
  it("ticks immediately, then every 5 seconds with the configured scenario and rate", async () => {
    const { runner, calls, timers } = setup()
    runner.configure("peak", 7)
    runner.start()
    await flush()
    assert.deepEqual(calls, [{ s: "peak", n: 7 }])
    await timers.advance(15_000)
    assert.equal(calls.length, 4)
    runner.configure("rain", 99) // clamped to the server limit of 25
    await timers.advance(5_000)
    assert.deepEqual(calls.at(-1), { s: "rain", n: 25 })
  })

  it("never overlaps calls when the database is slow", async () => {
    let inFlight = 0
    let maxInFlight = 0
    let release: () => void = () => {}
    const { runner, timers } = setup(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise<void>((r) => (release = r))
      inFlight--
      return result()
    })
    runner.start()
    await flush()
    await timers.advance(30_000) // no further ticks are scheduled while one is in flight
    assert.equal(maxInFlight, 1)
    release()
    await flush()
    assert.equal(maxInFlight, 1)
  })

  it("stop() cancels the loop and ignores a late response", async () => {
    let release: () => void = () => {}
    const results: TickResult[] = []
    const timers = new FakeTimers()
    const runner = new SimulatorRunner({
      timers,
      tick: () => new Promise((r) => (release = () => r(result()))),
      onResult: (x) => results.push(x),
    })
    runner.start()
    await flush()
    runner.stop()
    release()
    await flush()
    await timers.advance(60_000)
    assert.equal(results.length, 0)
    assert.equal(timers.pending, 0)
    assert.equal(runner.currentState, "idle")
  })

  it("rate-limit responses (QO429) are skipped, not treated as failures", async () => {
    let n = 0
    const { runner, timers, errors } = setup(async () => {
      n++
      if (n <= 2) throw new CodedError("QO429")
      return result()
    })
    runner.start()
    await flush()
    await timers.advance(10_000)
    assert.equal(runner.currentState, "running")
    assert.deepEqual(errors, [])
  })

  it("access denied (42501) stops immediately with a forbidden state", async () => {
    const { runner, timers, states } = setup(async () => {
      throw new CodedError("42501")
    })
    runner.start()
    await flush()
    await timers.advance(30_000)
    assert.equal(runner.currentState, "stopped_forbidden")
    assert.deepEqual(states, ["running", "stopped_forbidden"])
  })

  it("stops after 3 consecutive unexpected errors", async () => {
    const { runner, timers, errors } = setup(async () => {
      throw new Error("network down")
    })
    runner.start()
    await flush()
    await timers.advance(60_000)
    assert.equal(runner.currentState, "stopped_error")
    assert.deepEqual(errors, [1, 2, 3])
  })

  it("auto-stops after the maximum run duration", async () => {
    const timers = new FakeTimers()
    const runner = new SimulatorRunner({ timers, tick: async () => result(), maxDurationMs: 20_000 })
    runner.start()
    await flush()
    await timers.advance(60_000)
    assert.equal(runner.currentState, "stopped_timeout")
    assert.equal(timers.pending, 0)
  })
})
