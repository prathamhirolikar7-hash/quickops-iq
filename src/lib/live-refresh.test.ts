import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  ANALYTICS_EVENT, ANALYTICS_TOPIC, isAnalyticsSignal, LiveRefreshController,
  type ChannelLike, type LiveRefreshOptions, type LiveStatus, type RefreshReason, type Timers,
} from "./live-refresh.ts"

// ---------------------------------------------------------------- fakes
class FakeTimers implements Timers {
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
  /** Advance time, running due tasks in order (including ones they schedule) */
  advance(ms: number) {
    const end = this.t + ms
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
      if (!due.length) break
      const [id, task] = due[0]
      this.tasks.delete(id)
      this.t = task.at
      task.fn()
    }
    this.t = end
  }
}

class FakeChannel implements ChannelLike {
  topic: string
  private onMessage: ((m: { event?: string; payload?: unknown }) => void) | null = null
  statusCb: ((s: string, e?: Error) => void) | null = null
  removed = false
  filter: { event: string } | null = null
  name: string
  isPrivate: boolean
  constructor(name: string, isPrivate: boolean) {
    this.name = name
    this.isPrivate = isPrivate
    this.topic = `realtime:${name}`
  }
  on(_type: "broadcast", filter: { event: string }, cb: (m: { event?: string; payload?: unknown }) => void) {
    this.filter = filter
    this.onMessage = cb
    return this
  }
  subscribe(cb: (s: string, e?: Error) => void) {
    this.statusCb = cb
    return this
  }
  emitStatus(s: string, e?: Error) {
    this.statusCb?.(s, e)
  }
  emit(payload: unknown, event = ANALYTICS_EVENT) {
    this.onMessage?.({ event, payload })
  }
}

class FakeClient {
  created: FakeChannel[] = []
  setAuthCalls = 0
  realtime = { setAuth: async () => void this.setAuthCalls++ }
  channel(name: string, opts: { config: { private: boolean } }) {
    const ch = new FakeChannel(name, opts.config.private)
    this.created.push(ch)
    return ch
  }
  removeChannel(ch: ChannelLike) {
    const c = ch as FakeChannel
    c.removed = true
    c.emitStatus("CLOSED") // like supabase-js: removing a channel closes it
  }
  getChannels() {
    return this.created.filter((c) => !c.removed)
  }
  get active() {
    return this.created.filter((c) => !c.removed)
  }
}

const flush = () => new Promise((r) => setImmediate(r))
const signal = { table: "orders", op: "update", at: "2026-10-15T10:00:00Z" }

function setup(overrides: Partial<LiveRefreshOptions> = {}) {
  const timers = new FakeTimers()
  const client = new FakeClient()
  const refreshes: RefreshReason[] = []
  const statuses: LiveStatus[] = []
  const controller = new LiveRefreshController({
    client, timers, onRefresh: (r) => refreshes.push(r), onStatus: (s) => statuses.push(s), ...overrides,
  })
  return { timers, client, refreshes, statuses, controller }
}

// ---------------------------------------------------------------- tests
describe("subscription lifecycle", () => {
  it("subscribes once to the private analytics channel after refreshing auth", async () => {
    const { client, controller, statuses } = setup()
    controller.start()
    controller.start() // duplicate start is ignored
    await flush()
    assert.equal(client.setAuthCalls, 1)
    assert.equal(client.created.length, 1)
    assert.equal(client.created[0].name, ANALYTICS_TOPIC)
    assert.equal(client.created[0].isPrivate, true)
    assert.deepEqual(client.created[0].filter, { event: ANALYTICS_EVENT })
    assert.deepEqual(statuses, ["connecting"])
    client.created[0].emitStatus("SUBSCRIBED")
    assert.equal(controller.currentStatus, "live")
  })

  it("stop() removes the channel, clears every timer and ignores late callbacks", async () => {
    const { client, controller, timers, refreshes } = setup()
    controller.start()
    await flush()
    const ch = client.created[0]
    ch.emitStatus("SUBSCRIBED")
    ch.emit(signal)
    controller.stop()
    assert.equal(ch.removed, true)
    assert.equal(client.active.length, 0)
    assert.equal(timers.pending, 0)
    assert.equal(controller.currentStatus, "stopped")
    ch.emit(signal)
    ch.emitStatus("SUBSCRIBED")
    timers.advance(60 * 60_000)
    assert.deepEqual(refreshes, [])
  })

  it("stop() before the async subscribe finishes never leaves a channel behind", async () => {
    const { client, controller } = setup()
    controller.start()
    controller.stop() // still awaiting setAuth
    await flush()
    assert.equal(client.created.length, 0)
  })

  it("start/stop/start (React StrictMode) ends with exactly one active channel", async () => {
    const { client, controller } = setup()
    controller.start()
    controller.stop()
    controller.start()
    await flush()
    assert.equal(client.active.length, 1)
  })

  it("removes a stale channel with the same topic before subscribing", async () => {
    const { client, controller } = setup()
    const stale = client.channel(ANALYTICS_TOPIC, { config: { private: true } })
    controller.start()
    await flush()
    assert.equal(stale.removed, true)
    assert.equal(client.active.length, 1)
  })
})

describe("refresh behaviour", () => {
  it("debounces a burst of signals into a single refresh", async () => {
    const { client, controller, timers, refreshes } = setup()
    controller.start()
    await flush()
    client.created[0].emitStatus("SUBSCRIBED")
    for (let i = 0; i < 25; i++) client.created[0].emit(signal)
    timers.advance(1_499)
    assert.deepEqual(refreshes, [])
    timers.advance(1)
    assert.deepEqual(refreshes, ["signal"])
  })

  it("throttles signal refreshes to the minimum interval", async () => {
    const { client, controller, timers, refreshes } = setup()
    controller.start()
    await flush()
    const ch = client.created[0]
    ch.emitStatus("SUBSCRIBED")
    ch.emit(signal)
    timers.advance(1_500) // refresh #1 at t=1.5s
    ch.emit(signal)
    timers.advance(1_500) // debounce done at t=3s, but throttled until t=16.5s
    assert.equal(refreshes.length, 1)
    timers.advance(13_500)
    assert.deepEqual(refreshes, ["signal", "signal"])
  })

  it("ignores messages that are not analytics signals", async () => {
    const { client, controller, timers, refreshes } = setup()
    controller.start()
    await flush()
    const ch = client.created[0]
    ch.emitStatus("SUBSCRIBED")
    ch.emit({ table: "riders", op: "update" }) // not a signal table
    ch.emit(signal, "something_else") // wrong event
    ch.emit("not an object")
    ch.emit(null)
    timers.advance(30_000)
    assert.deepEqual(refreshes, [])
    assert.equal(isAnalyticsSignal({ event: ANALYTICS_EVENT, payload: signal }), true)
    assert.equal(isAnalyticsSignal({ event: ANALYTICS_EVENT, payload: { table: "orders" } }), false)
  })

  it("polls every 10 minutes while live and every minute while not live", async () => {
    const { client, controller, timers, refreshes } = setup()
    controller.start()
    await flush()
    timers.advance(60_000) // not live yet: offline polling
    assert.deepEqual(refreshes, ["poll"])
    client.created[0].emitStatus("SUBSCRIBED")
    timers.advance(9 * 60_000)
    assert.equal(refreshes.length, 1)
    timers.advance(60_000)
    assert.deepEqual(refreshes, ["poll", "poll"])
  })

  it("skips polling while the tab is hidden", async () => {
    let visible = false
    const { controller, timers, refreshes } = setup({ isVisible: () => visible })
    controller.start()
    await flush()
    timers.advance(3 * 60_000)
    assert.deepEqual(refreshes, [])
    visible = true
    timers.advance(60_000)
    assert.deepEqual(refreshes, ["poll"])
  })
})

describe("errors and reconnects", () => {
  it("channel error -> reconnecting, backoff resubscribe, catch-up refresh when live again", async () => {
    const { client, controller, timers, refreshes, statuses } = setup()
    controller.start()
    await flush()
    client.created[0].emitStatus("SUBSCRIBED")
    client.created[0].emitStatus("CHANNEL_ERROR", new Error("socket dropped"))
    assert.equal(controller.currentStatus, "reconnecting")
    assert.equal(client.active.length, 0)
    timers.advance(1_999)
    assert.equal(client.created.length, 1) // backoff not elapsed
    timers.advance(1)
    await flush()
    assert.equal(client.created.length, 2)
    client.created[1].emitStatus("SUBSCRIBED")
    assert.equal(controller.currentStatus, "live")
    assert.deepEqual(refreshes, ["reconnect"]) // catch up on missed changes
    assert.deepEqual(statuses, ["connecting", "live", "reconnecting", "live"])
  })

  it("removing the failed channel does not count as a second failure", async () => {
    const { client, controller } = setup()
    controller.start()
    await flush()
    client.created[0].emitStatus("TIMED_OUT") // removeChannel then emits CLOSED
    assert.equal(controller.currentStatus, "reconnecting")
  })

  it("repeated failures (e.g. channel not authorized) -> unavailable, capped backoff, keeps polling", async () => {
    const { client, controller, timers, refreshes } = setup()
    controller.start()
    for (let i = 0; i < 4; i++) {
      await flush()
      client.created.at(-1)!.emitStatus("CHANNEL_ERROR", new Error("Unauthorized"))
      timers.advance(60_000)
    }
    assert.equal(controller.currentStatus, "unavailable")
    assert.ok(refreshes.filter((r) => r === "poll").length >= 3, "falls back to polling")
    assert.ok(client.created.length <= 5, "no subscription storm")
    assert.ok(client.active.length <= 1, "never more than one channel at a time")
  })

  it("a failing setAuth does not crash the controller", async () => {
    const { client, controller } = setup()
    client.realtime.setAuth = async () => {
      throw new Error("no session")
    }
    controller.start()
    await flush()
    assert.equal(client.created.length, 1)
  })
})
