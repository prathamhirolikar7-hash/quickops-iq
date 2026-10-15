import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { analytics } from "@/lib/analytics"
import { SimulatorRunner, type RunnerState, type Scenario, type TickResult } from "@/lib/simulator-runner"
import {
  SIMULATOR_STATUS_KEY, SimulatorContext, codeOf, friendlySimulatorError, type ActivityEntry, type SimulatorContextValue,
} from "./simulator-context"

/**
 * Owns the browser-driven simulator loop for an operator session. Mounted in
 * the dashboard shell, so a live run continues while browsing other pages and
 * stops when the shell unmounts (sign-out) or the tab closes.
 */
export function SimulatorProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<RunnerState>("idle")
  const [scenario, setScenarioState] = useState<Scenario>("normal")
  const [rate, setRateState] = useState(3)
  const [busy, setBusy] = useState<SimulatorContextValue["busy"]>(null)
  const [lastResult, setLastResult] = useState<TickResult | null>(null)
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const runnerRef = useRef<SimulatorRunner | null>(null)

  const log = useCallback((kind: ActivityEntry["kind"], message: string) => {
    setActivity((a) => [{ at: new Date().toISOString(), kind, message }, ...a].slice(0, 12))
  }, [])

  const onResult = useCallback(
    (r: TickResult, kind: "tick" | "burst") => {
      setLastResult(r)
      setError(null)
      queryClient.setQueryData(SIMULATOR_STATUS_KEY, r)
      if (r.created > 0 || r.steps_applied > 0) {
        log(kind, `${r.created} new order${r.created === 1 ? "" : "s"}, ${r.steps_applied} lifecycle step${r.steps_applied === 1 ? "" : "s"}${r.capped ? " (capped)" : ""}`)
      }
    },
    [queryClient, log],
  )

  useEffect(() => {
    if (!enabled) return
    const runner = new SimulatorRunner({
      tick: (s, n) => analytics.simulatorTick(s, n),
      codeOf,
      onResult: (r) => onResult(r, "tick"),
      onError: (e) => {
        const msg = friendlySimulatorError(e)
        setError(msg)
        log("error", msg)
      },
      onState: setState,
    })
    runnerRef.current = runner
    return () => {
      runner.stop()
      runnerRef.current = null
    }
  }, [enabled, onResult, log])

  // Keep the runner's settings in sync
  useEffect(() => {
    runnerRef.current?.configure(scenario, rate)
  }, [scenario, rate])

  const start = useCallback(() => {
    setError(null)
    runnerRef.current?.configure(scenario, rate)
    runnerRef.current?.start()
  }, [scenario, rate])
  const stop = useCallback(() => runnerRef.current?.stop(), [])

  const burst = useCallback(
    async (n: number) => {
      setBusy("burst")
      try {
        onResult(await analytics.simulatorTick(scenario, n), "burst")
      } catch (e) {
        const msg = friendlySimulatorError(e)
        setError(msg)
        log("error", msg)
      } finally {
        setBusy(null)
      }
    },
    [scenario, onResult, log],
  )

  const reset = useCallback(async () => {
    runnerRef.current?.stop()
    setBusy("reset")
    try {
      const r = await analytics.simulatorReset()
      queryClient.setQueryData(SIMULATOR_STATUS_KEY, r)
      setLastResult(null)
      setError(null)
      log("reset", `Removed ${r.deleted_orders} simulated orders, ${r.deleted_stock_events} stock movements, ${r.deleted_refunds} refunds`)
      void queryClient.invalidateQueries({ queryKey: ["analytics"] })
    } catch (e) {
      const msg = friendlySimulatorError(e)
      setError(msg)
      log("error", msg)
    } finally {
      setBusy(null)
    }
  }, [queryClient, log])

  const value = useMemo<SimulatorContextValue>(
    () => ({
      available: enabled,
      state,
      scenario,
      rate,
      setScenario: setScenarioState,
      setRate: (n) => setRateState(Math.max(1, Math.min(25, Math.round(n)))),
      start,
      stop,
      burst,
      reset,
      busy,
      lastResult,
      activity,
      error,
    }),
    [enabled, state, scenario, rate, start, stop, burst, reset, busy, lastResult, activity, error],
  )

  return <SimulatorContext.Provider value={value}>{children}</SimulatorContext.Provider>
}
