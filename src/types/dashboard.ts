import type { DateRangeKey } from "../lib/dates.ts"

export const ALL = "all" as const

export interface DashboardFilters {
  city: string // city id or "all"
  store: string // store id or "all"
  range: DateRangeKey
}

export const DEFAULT_FILTERS: DashboardFilters = { city: ALL, store: ALL, range: "7d" }

export type KpiFormat = "number" | "currency" | "percent" | "minutes"

export interface KpiMetric {
  id: string
  label: string
  /** null when there is no data for the current selection */
  value: number | null
  /** null when the previous period has no comparable value */
  previous: number | null
  format: KpiFormat
  /** Whether an increase is good ("up") or bad ("down"), e.g. delivery time */
  goodDirection: "up" | "down"
  hint: string
  sparkline: number[]
}

export interface TrendPoint {
  label: string
  current: number
  previous: number
}

export interface BreakdownPoint {
  id: string
  name: string
  /** rupees */
  gmv: number
  orders: number
}

export interface HourlyPoint {
  hour: string
  orders: number
}

export interface DeliveryBucket {
  bucket: string
  orders: number
  withinSla: boolean
}

export interface StoreRow {
  id: string
  name: string
  city: string
  orders: number
  /** rupees */
  gmv: number
  avgDeliveryMin: number | null
  onTimePct: number | null
}
