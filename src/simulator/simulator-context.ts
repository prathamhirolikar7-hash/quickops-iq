import { createContext, useContext } from "react"
import { AnalyticsError, type SimulatorStatus } from "@/lib/analytics"
import type { RunnerState, Scenario, TickResult } from "@/lib/simulator-runner"

export interface ActivityEntry {
  at: string
  kind: "tick" | "burst" | "reset" | "error"
  message: string
}

export interface SimulatorContextValue {
  /** Operators only; viewers never get a runner */
  available: boolean
  state: RunnerState
  scenario: Scenario
  rate: number
  setScenario: (s: Scenario) => void
  setRate: (n: number) => void
  start: () => void
  stop: () => void
  burst: (n: number) => Promise<void>
  reset: () => Promise<void>
  busy: "burst" | "reset" | null
  lastResult: TickResult | null
  activity: ActivityEntry[]
  error: string | null
}

export const SimulatorContext = createContext<SimulatorContextValue | null>(null)

export function useSimulator(): SimulatorContextValue {
  const ctx = useContext(SimulatorContext)
  if (!ctx) throw new Error("useSimulator must be used inside <SimulatorProvider>")
  return ctx
}

export const SIMULATOR_STATUS_KEY = ["simulator", "status"] as const

export const codeOf = (e: unknown) => (e instanceof AnalyticsError ? e.code : undefined)

export function friendlySimulatorError(e: unknown): string {
  const code = codeOf(e)
  if (code === "42501") return "Operator access required. Ask an administrator to mark your account as an operator."
  if (code === "QO429") return "The simulator is busy (one tick every 2 seconds). Try again in a moment."
  if (code === "PGRST202" || code === "42883") return "The simulator is not installed yet (apply migration 005)."
  if (code === "22023") return "The simulator rejected these settings."
  return "The simulator request failed. Check your connection and try again."
}
export type { SimulatorStatus }
