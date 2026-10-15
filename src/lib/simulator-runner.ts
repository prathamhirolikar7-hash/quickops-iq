// Browser-driven simulator loop: calls the operator-only simulator_tick RPC on
// an interval. All limits are ALSO enforced by the database (operator check,
// 2-second rate limit, 25 orders per tick, open/total caps); this loop just
// stays polite: never overlaps calls, stops on access or validation errors,
// stops after repeated failures, and auto-stops after a maximum duration.
//
// Framework-agnostic so it can be unit-tested with fake timers.

export type Scenario = "normal" | "peak" | "rain" | "stockout"
export const SCENARIOS: { value: Scenario; label: string; hint: string }[] = [
  { value: "normal", label: "Normal day", hint: "Typical demand and delivery times" },
  { value: "peak", label: "Peak hour", hint: "Longer queues and rider waits, heavier traffic" },
  { value: "rain", label: "Monsoon rain", hint: "Riders travel about 40% slower" },
  { value: "stockout", label: "Stockout surge", hint: "Bigger baskets, no restocking: short picks and refunds" },
]

export interface TickResult {
  created: number
  requested: number
  capped: boolean
  steps_applied: number
  scenario: Scenario
  total_orders: number
  open_orders: number
  delivered_orders: number
  cancelled_orders: number
  created_today: number
  last_tick_at: string | null
  max_open_orders: number
  max_total_orders: number
}

export type RunnerState = "idle" | "running" | "stopped_error" | "stopped_forbidden" | "stopped_timeout"

export interface RunnerTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

export interface RunnerOptions {
  tick: (scenario: Scenario, newOrders: number) => Promise<TickResult>
  onResult?: (r: TickResult) => void
  onError?: (e: unknown, consecutive: number) => void
  onState?: (s: RunnerState) => void
  /** Error classifier: SQLSTATE-like code of an error, if any */
  codeOf?: (e: unknown) => string | undefined
  intervalMs?: number
  maxConsecutiveErrors?: number
  maxDurationMs?: number
  timers?: RunnerTimers
}

const defaultTimers: RunnerTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
}

export class SimulatorRunner {
  private readonly o: Required<Omit<RunnerOptions, "onResult" | "onError" | "onState" | "codeOf">> &
    Pick<RunnerOptions, "onResult" | "onError" | "onState" | "codeOf">
  private state: RunnerState = "idle"
  private scenario: Scenario = "normal"
  private rate = 3
  private timer: unknown = null
  private inFlight = false
  private generation = 0
  private consecutiveErrors = 0
  private startedAt = 0

  constructor(options: RunnerOptions) {
    this.o = {
      intervalMs: 5_000,
      maxConsecutiveErrors: 3,
      maxDurationMs: 30 * 60_000,
      timers: defaultTimers,
      ...(Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as RunnerOptions),
    }
  }

  get currentState(): RunnerState {
    return this.state
  }

  /** Change scenario/rate; takes effect on the next tick */
  configure(scenario: Scenario, rate: number): void {
    this.scenario = scenario
    this.rate = Math.max(0, Math.min(25, Math.round(rate)))
  }

  start(): void {
    if (this.state === "running") return
    this.generation++
    this.consecutiveErrors = 0
    this.startedAt = this.o.timers.now()
    this.setState("running")
    void this.runTick(this.generation)
  }

  stop(): void {
    this.generation++
    if (this.timer !== null) this.o.timers.clearTimeout(this.timer)
    this.timer = null
    if (this.state === "running") this.setState("idle")
  }

  private schedule(gen: number): void {
    if (gen !== this.generation || this.state !== "running") return
    if (this.o.timers.now() - this.startedAt >= this.o.maxDurationMs) {
      this.generation++
      this.setState("stopped_timeout")
      return
    }
    this.timer = this.o.timers.setTimeout(() => {
      this.timer = null
      void this.runTick(gen)
    }, this.o.intervalMs)
  }

  private async runTick(gen: number): Promise<void> {
    if (gen !== this.generation) return
    if (this.inFlight) {
      // A previous run's call is still finishing (e.g. quick stop + start): never overlap, retry next interval
      this.schedule(gen)
      return
    }
    this.inFlight = true
    try {
      const result = await this.o.tick(this.scenario, this.rate)
      if (gen !== this.generation) return
      this.consecutiveErrors = 0
      this.o.onResult?.(result)
    } catch (e) {
      if (gen !== this.generation) return
      const code = this.o.codeOf?.(e)
      if (code === "QO429") {
        // Another tick (e.g. a manual burst) just ran; simply try again next interval
      } else if (code === "42501") {
        this.generation++
        this.setState("stopped_forbidden")
        this.o.onError?.(e, ++this.consecutiveErrors)
        return
      } else {
        this.consecutiveErrors++
        this.o.onError?.(e, this.consecutiveErrors)
        if (code === "22023" || this.consecutiveErrors >= this.o.maxConsecutiveErrors) {
          this.generation++
          this.setState("stopped_error")
          return
        }
      }
    } finally {
      this.inFlight = false
    }
    this.schedule(gen)
  }

  private setState(s: RunnerState): void {
    if (s === this.state) return
    this.state = s
    this.o.onState?.(s)
  }
}
