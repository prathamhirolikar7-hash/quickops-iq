// Live-refresh controller: listens for "analytics changed" signals on a private
// Supabase Realtime channel and turns them into debounced, throttled refreshes
// of the existing analytics queries. Signals carry NO business data; all
// numbers are re-read through the RLS-protected analytics functions.
//
// Framework-agnostic (no React, no Supabase import) so the lifecycle can be
// unit-tested with a fake client and fake timers.

export const ANALYTICS_TOPIC = "quickops:analytics"
export const ANALYTICS_EVENT = "analytics_changed"
const SIGNAL_TABLES = new Set(["orders", "refunds"])

/**
 * connecting   first subscribe in progress
 * live         subscribed; changes trigger refreshes
 * reconnecting subscribe failed or dropped; retrying with backoff (polling meanwhile)
 * unavailable  repeated failures (e.g. channel not authorized yet); still retrying slowly, polling
 * stopped      controller stopped (signed out / unmounted)
 */
export type LiveStatus = "connecting" | "live" | "reconnecting" | "unavailable" | "stopped"
export type RefreshReason = "signal" | "reconnect" | "poll"

// Minimal shapes of the supabase-js objects we use
export interface ChannelLike {
  topic?: string
  on(type: "broadcast", filter: { event: string }, callback: (message: { event?: string; payload?: unknown }) => void): ChannelLike
  subscribe(callback: (status: string, err?: Error) => void): ChannelLike
}
export interface RealtimeClientLike {
  channel(name: string, opts: { config: { private: boolean } }): ChannelLike
  removeChannel(channel: ChannelLike): unknown
  getChannels?(): ChannelLike[]
  realtime?: { setAuth(token?: string | null): unknown }
}
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

export interface LiveRefreshOptions {
  client: RealtimeClientLike
  onRefresh: (reason: RefreshReason) => void
  onStatus: (status: LiveStatus) => void
  /** Coalesce bursts of signals (e.g. a batch of writes) into one refresh */
  debounceMs?: number
  /** Never refresh from signals more often than this */
  minRefreshIntervalMs?: number
  /** Safety-net polling while live */
  pollWhileLiveMs?: number
  /** Polling while not live (fallback) */
  pollWhileOfflineMs?: number
  /** Reconnect backoff: base doubles up to max */
  backoffBaseMs?: number
  backoffMaxMs?: number
  /** Consecutive failures before reporting "unavailable" */
  failuresBeforeUnavailable?: number
  /** Skip polling while the tab is hidden */
  isVisible?: () => boolean
  timers?: Timers
  log?: (message: string) => void
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
}

export function isAnalyticsSignal(message: unknown): boolean {
  if (!message || typeof message !== "object") return false
  const m = message as { event?: unknown; payload?: unknown }
  if (m.event !== ANALYTICS_EVENT) return false
  const p = m.payload as { table?: unknown; op?: unknown } | undefined
  return !!p && typeof p.table === "string" && SIGNAL_TABLES.has(p.table) && typeof p.op === "string"
}

export class LiveRefreshController {
  private readonly o: Required<Omit<LiveRefreshOptions, "log">> & { log: (m: string) => void }
  private channel: ChannelLike | null = null
  private status: LiveStatus = "stopped"
  private started = false
  private everLive = false
  private failures = 0
  private generation = 0
  private lastRefreshAt = Number.NEGATIVE_INFINITY
  private debounceTimer: unknown = null
  private retryTimer: unknown = null
  private pollTimer: unknown = null

  constructor(options: LiveRefreshOptions) {
    this.o = {
      debounceMs: 1500,
      minRefreshIntervalMs: 15_000,
      pollWhileLiveMs: 10 * 60_000,
      pollWhileOfflineMs: 60_000,
      backoffBaseMs: 2_000,
      backoffMaxMs: 60_000,
      failuresBeforeUnavailable: 3,
      isVisible: () => true,
      timers: defaultTimers,
      log: () => {},
      // An option passed as undefined keeps its default
      ...(Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as LiveRefreshOptions),
    }
  }

  get currentStatus(): LiveStatus {
    return this.status
  }

  /** Idempotent: calling start() twice never creates a second subscription */
  start(): void {
    if (this.started) return
    this.started = true
    this.setStatus("connecting")
    this.schedulePoll()
    void this.subscribe()
  }

  /** Remove the channel and every timer. Safe to call repeatedly. */
  stop(): void {
    if (!this.started) return
    this.started = false
    this.generation++
    for (const t of [this.debounceTimer, this.retryTimer, this.pollTimer]) if (t !== null) this.o.timers.clearTimeout(t)
    this.debounceTimer = this.retryTimer = this.pollTimer = null
    this.teardownChannel()
    this.setStatus("stopped")
  }

  private async subscribe(): Promise<void> {
    const gen = ++this.generation
    this.teardownChannel()
    // Defensive: never keep a stale channel on the same topic (e.g. after hot reload)
    for (const ch of this.o.client.getChannels?.() ?? []) {
      if (ch.topic === `realtime:${ANALYTICS_TOPIC}`) this.o.client.removeChannel(ch)
    }
    try {
      // Private channels are authorized with the user's current access token
      await this.o.client.realtime?.setAuth()
    } catch (e) {
      this.o.log(`setAuth failed: ${(e as Error).message}`)
    }
    if (!this.started || gen !== this.generation) return
    this.channel = this.o.client
      .channel(ANALYTICS_TOPIC, { config: { private: true } })
      .on("broadcast", { event: ANALYTICS_EVENT }, (message) => {
        if (gen === this.generation) this.handleMessage(message)
      })
      .subscribe((status, err) => {
        if (gen === this.generation) this.handleChannelStatus(status, err)
      })
  }

  private handleChannelStatus(status: string, err?: Error): void {
    if (!this.started) return
    if (status === "SUBSCRIBED") {
      const wasReconnect = this.everLive || this.failures > 0
      this.failures = 0
      this.everLive = true
      this.setStatus("live")
      this.schedulePoll()
      // Changes may have happened while we were not listening: catch up once
      if (wasReconnect) this.refresh("reconnect")
      return
    }
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      this.o.log(`channel ${status}${err ? `: ${err.message}` : ""}`)
      this.failures++
      // Ignore any further callbacks from this channel (removeChannel may emit CLOSED)
      this.generation++
      this.teardownChannel()
      this.setStatus(this.failures >= this.o.failuresBeforeUnavailable ? "unavailable" : "reconnecting")
      this.schedulePoll()
      const delay = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** (this.failures - 1))
      if (this.retryTimer !== null) this.o.timers.clearTimeout(this.retryTimer)
      this.retryTimer = this.o.timers.setTimeout(() => {
        this.retryTimer = null
        if (this.started) void this.subscribe()
      }, delay)
    }
  }

  private handleMessage(message: unknown): void {
    if (!this.started || !isAnalyticsSignal(message)) return
    if (this.debounceTimer !== null) return // a refresh is already scheduled
    this.debounceTimer = this.o.timers.setTimeout(() => this.flush(), this.o.debounceMs)
  }

  private flush(): void {
    this.debounceTimer = null
    if (!this.started) return
    const wait = this.lastRefreshAt + this.o.minRefreshIntervalMs - this.o.timers.now()
    if (wait > 0) {
      this.debounceTimer = this.o.timers.setTimeout(() => this.flush(), wait)
      return
    }
    this.refresh("signal")
  }

  private schedulePoll(): void {
    if (this.pollTimer !== null) this.o.timers.clearTimeout(this.pollTimer)
    if (!this.started) return
    const interval = this.status === "live" ? this.o.pollWhileLiveMs : this.o.pollWhileOfflineMs
    this.pollTimer = this.o.timers.setTimeout(() => {
      this.pollTimer = null
      if (!this.started) return
      if (this.o.isVisible()) this.refresh("poll")
      this.schedulePoll()
    }, interval)
  }

  private refresh(reason: RefreshReason): void {
    this.lastRefreshAt = this.o.timers.now()
    this.o.log(`refresh (${reason})`)
    this.o.onRefresh(reason)
  }

  private teardownChannel(): void {
    if (this.channel) {
      const ch = this.channel
      this.channel = null
      this.o.client.removeChannel(ch)
    }
  }

  private setStatus(status: LiveStatus): void {
    if (status === this.status) return
    this.status = status
    this.o.log(`status ${status}`)
    this.o.onStatus(status)
  }
}
