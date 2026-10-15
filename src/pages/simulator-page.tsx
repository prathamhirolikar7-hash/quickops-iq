import { useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Activity, CircleCheck, CircleX, FlaskConical, Hourglass, Loader2, Play, RotateCcw, ShieldAlert, Square, Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { EmptyState } from "@/components/dashboard/state-views"
import { analytics } from "@/lib/analytics"
import { formatNumber, formatTime } from "@/lib/format"
import { SCENARIOS, type Scenario } from "@/lib/simulator-runner"
import { cn } from "@/lib/utils"
import { SIMULATOR_STATUS_KEY, friendlySimulatorError, useSimulator } from "@/simulator/simulator-context"

const STATE_TEXT = {
  idle: "Stopped",
  running: "Running: one tick every 5 seconds (auto-stops after 30 minutes)",
  stopped_error: "Stopped after repeated errors",
  stopped_forbidden: "Stopped: operator access required",
  stopped_timeout: "Stopped automatically after 30 minutes",
} as const

export function SimulatorPage() {
  const sim = useSimulator()

  if (!sim.available) {
    return (
      <Frame>
        <EmptyState
          icon={ShieldAlert}
          title="Operator access required"
          description="The order simulator writes demo data, so it is limited to operators. Your account has read-only (viewer) access."
        />
      </Frame>
    )
  }
  return <SimulatorPanel />
}

function SimulatorPanel() {
  const sim = useSimulator()
  const [burstSize, setBurstSize] = useState(10)
  const [confirmReset, setConfirmReset] = useState(false)
  const running = sim.state === "running"

  const status = useQuery({
    queryKey: SIMULATOR_STATUS_KEY,
    queryFn: analytics.simulatorStatus,
    refetchInterval: running ? false : 15_000, // while running, every tick result updates it
  })
  const s = status.data

  return (
    <Frame>
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[28px]">Order Simulator</h1>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-primary uppercase">
            <ShieldAlert className="size-3.5" aria-hidden /> Operator
          </span>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Creates synthetic <span className="font-medium text-foreground/80">SIM-</span> orders at live dark stores. They move through
          the real lifecycle (placed → picking → packed → out for delivery → delivered or cancelled), use real stock and riders, and
          update every dashboard live. Reset removes only simulated data; the 20,000 seed orders are never touched.
        </p>
      </div>

      {/* Status tiles */}
      <section aria-label="Simulator status" className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Tile icon={FlaskConical} label="Simulated orders" value={s?.total_orders} hint={s ? `limit ${formatNumber(s.max_total_orders)}` : undefined} loading={status.isPending} />
        <Tile icon={Hourglass} label="In progress" value={s?.open_orders} hint={s ? `limit ${formatNumber(s.max_open_orders)}` : undefined} loading={status.isPending} />
        <Tile icon={CircleCheck} label="Delivered" value={s?.delivered_orders} loading={status.isPending} />
        <Tile icon={CircleX} label="Cancelled" value={s?.cancelled_orders} loading={status.isPending} />
        <Tile icon={Activity} label="Created today (IST)" value={s?.created_today}
          hint={s?.last_tick_at ? `last tick ${formatTime(s.last_tick_at)}` : "no ticks yet"} loading={status.isPending} />
      </section>

      {sim.error && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{sim.error}</p>
      )}
      {status.isError && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {friendlySimulatorError(status.error)}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Live run */}
        <Card className="gap-4 border-0 lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-[15px] font-semibold">Live simulation</CardTitle>
            <CardDescription className="text-xs">Runs from this browser tab; it stops when you stop it, sign out or close the tab.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Scenario">
                <Select items={SCENARIOS.map(({ value, label }) => ({ value, label }))} value={sim.scenario}
                  onValueChange={(v) => typeof v === "string" && sim.setScenario(v as Scenario)}>
                  <SelectTrigger aria-label="Scenario" className="h-9 w-full bg-card/60 dark:bg-card/60 data-[size=default]:h-9">
                    <SelectValue className="font-medium" />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false} align="start">
                    <SelectGroup>
                      {SCENARIOS.map((sc) => <SelectItem key={sc.value} value={sc.value}>{sc.label}</SelectItem>)}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">{SCENARIOS.find((x) => x.value === sim.scenario)?.hint}</p>
              </Field>
              <Field label={`New orders per tick: ${sim.rate}`}>
                <input type="range" min={1} max={25} value={sim.rate} onChange={(e) => sim.setRate(Number(e.target.value))}
                  aria-label="New orders per tick" className="h-9 w-full accent-[var(--primary)]" />
                <p className="text-[11px] text-muted-foreground">≈ {formatNumber(sim.rate * 12)} orders per minute</p>
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {running ? (
                <Button variant="outline" onClick={sim.stop}><Square data-icon="inline-start" /> Stop</Button>
              ) : (
                <Button onClick={sim.start} disabled={sim.busy !== null}><Play data-icon="inline-start" /> Start live simulation</Button>
              )}
              <span className={cn("flex items-center gap-2 text-xs", running ? "text-success" : "text-muted-foreground")} role="status">
                <span className={cn("size-2 rounded-full", running ? "animate-pulse bg-success" : "bg-muted-foreground")} aria-hidden />
                {STATE_TEXT[sim.state]}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* One-off burst */}
        <Card className="gap-4 border-0">
          <CardHeader>
            <CardTitle className="text-[15px] font-semibold">Burst</CardTitle>
            <CardDescription className="text-xs">Create a batch of orders once, using the selected scenario.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label={`Orders: ${burstSize}`}>
              <input type="range" min={1} max={25} value={burstSize} onChange={(e) => setBurstSize(Number(e.target.value))}
                aria-label="Burst size" className="h-9 w-full accent-[var(--primary)]" />
            </Field>
            <Button className="w-full" variant="outline" disabled={running || sim.busy !== null} onClick={() => sim.burst(burstSize)}>
              {sim.busy === "burst" ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Zap data-icon="inline-start" />}
              Create {burstSize} orders
            </Button>
            {running && <p className="text-[11px] text-muted-foreground">Stop the live run to create a burst.</p>}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Activity */}
        <Card className="gap-4 border-0 lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-[15px] font-semibold">Activity</CardTitle>
            <CardDescription className="text-xs">This session's simulator actions (most recent first)</CardDescription>
          </CardHeader>
          <CardContent>
            {sim.activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity yet. Start a live simulation or create a burst.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {sim.activity.map((a, i) => (
                  <li key={`${a.at}-${i}`} className="flex gap-3">
                    <span className="w-16 shrink-0 text-xs text-muted-foreground tabular">{formatTime(a.at)}</span>
                    <span className={cn(a.kind === "error" ? "text-destructive" : a.kind === "reset" ? "text-warning" : "text-foreground/90")}>
                      {a.message}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Reset */}
        <Card className="gap-4 border-0 ring-destructive/20">
          <CardHeader>
            <CardTitle className="text-[15px] font-semibold">Reset simulated data</CardTitle>
            <CardDescription className="text-xs">
              Deletes every SIM- order with its items, events and refunds, and restores stock exactly. Seed data is untouched.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {!confirmReset ? (
              <Button variant="destructive" className="w-full" disabled={sim.busy !== null || !s?.total_orders}
                onClick={() => setConfirmReset(true)}>
                <RotateCcw data-icon="inline-start" /> Reset simulated orders
              </Button>
            ) : (
              <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
                <p className="text-sm text-foreground">
                  Delete {formatNumber(s?.total_orders ?? 0)} simulated order{s?.total_orders === 1 ? "" : "s"}? This cannot be undone.
                </p>
                <div className="flex gap-2">
                  <Button variant="destructive" size="sm" disabled={sim.busy !== null}
                    onClick={async () => { await sim.reset(); setConfirmReset(false) }}>
                    {sim.busy === "reset" && <Loader2 className="animate-spin" data-icon="inline-start" />}
                    Yes, delete simulated data
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmReset(false)}>Cancel</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Frame>
  )
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1600px] space-y-6 px-4 py-6 sm:px-6 lg:py-8">{children}</div>
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  )
}

function Tile({ icon: Icon, label, value, hint, loading }: {
  icon: typeof Zap
  label: string
  value: number | undefined
  hint?: string
  loading?: boolean
}) {
  return (
    <Card className="gap-1 border-0 px-4 py-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        <Icon className="size-4 text-primary" aria-hidden />
      </div>
      <p className="text-2xl font-semibold tracking-tight text-foreground">{loading || value === undefined ? "—" : formatNumber(Number(value))}</p>
      <p className="h-4 text-[11px] text-muted-foreground">{hint}</p>
    </Card>
  )
}
