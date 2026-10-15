// Typed wrappers for the Supabase analytics RPCs (migration 003).
// All aggregation happens in Postgres; the browser only receives result rows.
import { requireSupabase } from "@/lib/supabase"
import type { IsoDate } from "@/lib/dates"
import type { TickResult } from "@/lib/simulator-runner"

export type SimulatorStatus = Pick<TickResult,
  "total_orders" | "open_orders" | "delivered_orders" | "cancelled_orders" | "created_today" | "last_tick_at" |
  "max_open_orders" | "max_total_orders">

export interface AnalyticsScope {
  start: IsoDate
  end: IsoDate
  cityId: string | null
  storeId: string | null
}

/** Error carrying the Postgres SQLSTATE (e.g. 42501 = not an approved member) */
export class AnalyticsError extends Error {
  code: string | undefined
  constructor(message: string, code?: string) {
    super(message)
    this.name = "AnalyticsError"
    this.code = code
  }
}

export const isAccessDenied = (e: unknown) => e instanceof AnalyticsError && e.code === "42501"
export const isInvalidRequest = (e: unknown) => e instanceof AnalyticsError && e.code === "22023"

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T[]> {
  const { data, error } = await requireSupabase().rpc(fn, args)
  if (error) throw new AnalyticsError(error.message, error.code)
  return (data ?? []) as T[]
}

/** RPCs that return a single jsonb value */
async function jsonRpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await requireSupabase().rpc(fn, args)
  if (error) throw new AnalyticsError(error.message, error.code)
  return data as T
}

const scopeArgs = (s: AnalyticsScope) => ({
  p_start_date: s.start,
  p_end_date: s.end,
  p_city_id: s.cityId,
  p_store_id: s.storeId,
})

// ---------------------------------------------------------------------------
// Row types (money in paise; rates 0-100; NULL when the denominator is 0)
// ---------------------------------------------------------------------------
export interface FreshnessRow {
  first_order_date: IsoDate | null
  last_order_date: IsoDate | null
  last_order_placed_at: string | null
  total_orders: number
  today_ist: IsoDate
}

export interface OverviewRow {
  period_start: IsoDate
  period_end: IsoDate
  previous_start: IsoDate
  previous_end: IsoDate
  is_partial_period: boolean
  total_orders: number
  delivered_orders: number
  cancelled_orders: number
  open_orders: number
  gmv_paise: number
  discount_paise: number
  refund_paise: number
  net_sales_paise: number
  aov_paise: number | null
  cancellation_rate_pct: number | null
  on_time_rate_pct: number | null
  avg_delivery_minutes: number | null
  p90_delivery_minutes: number | null
  active_dark_stores: number
  prev_total_orders: number
  prev_delivered_orders: number
  prev_cancelled_orders: number
  prev_gmv_paise: number
  prev_net_sales_paise: number
  prev_aov_paise: number | null
  prev_cancellation_rate_pct: number | null
  prev_on_time_rate_pct: number | null
  prev_avg_delivery_minutes: number | null
  prev_active_dark_stores: number
}

export interface DailyRow {
  report_date: IsoDate
  previous_date: IsoDate
  is_partial_day: boolean
  orders: number
  delivered_orders: number
  cancelled_orders: number
  gmv_paise: number
  net_sales_paise: number
  aov_paise: number | null
  on_time_rate_pct: number | null
  avg_delivery_minutes: number | null
  prev_orders: number
  prev_gmv_paise: number
  prev_net_sales_paise: number
  prev_on_time_rate_pct: number | null
  prev_avg_delivery_minutes: number | null
}

export interface HourlyRow {
  hour_ist: number
  orders: number
  avg_orders_per_day: number
  delivered_orders: number
  late_orders: number
  on_time_rate_pct: number | null
  avg_delivery_minutes: number | null
}

export interface CityPerformanceRow {
  city_id: string
  city_code: string
  city_name: string
  active_dark_stores: number
  orders: number
  delivered_orders: number
  cancelled_orders: number
  gmv_paise: number
  net_sales_paise: number
  aov_paise: number | null
  gmv_share_pct: number | null
  cancellation_rate_pct: number | null
  on_time_rate_pct: number | null
  avg_delivery_minutes: number | null
}

export interface StorePerformanceRow {
  store_id: string
  store_code: string
  store_name: string
  city_name: string
  store_status: string
  orders: number
  delivered_orders: number
  cancelled_orders: number
  gmv_paise: number
  net_sales_paise: number
  aov_paise: number | null
  avg_fulfillment_minutes: number | null
  avg_delivery_minutes: number | null
  on_time_rate_pct: number | null
  cancellation_rate_pct: number | null
  fill_rate_pct: number | null
  gmv_rank: number
}

export interface DeliveryDistributionRow {
  bucket_order: number
  bucket_label: string
  min_minutes: number
  max_minutes: number | null
  within_10_min: boolean
  orders: number
  share_pct: number | null
}

export interface OrderPageRow {
  order_id: string
  order_number: string
  placed_at: string
  order_date: IsoDate
  status: OrderStatus
  city_name: string
  store_code: string
  store_name: string
  rider_name: string | null
  payment_method: string
  items_count: number
  item_total_paise: number
  discount_paise: number
  delivery_fee_paise: number
  total_paise: number
  delivery_minutes: number | null
  sla_deadline_at: string
  delivered_at: string | null
  sla_met: boolean | null
  cancellation_reason: string | null
  total_count: number
  row_number: number
}

export type OrderStatus = "placed" | "confirmed" | "picking" | "packed" | "out_for_delivery" | "delivered" | "cancelled"
export const OPEN_STATUSES: OrderStatus[] = ["placed", "confirmed", "picking", "packed", "out_for_delivery"]
export type OrderSortBy = "placed_at" | "order_number" | "total" | "delivery_time" | "status" | "store"

export interface OrdersPageParams {
  statuses: OrderStatus[] | null
  search: string
  sortBy: OrderSortBy
  sortDir: "asc" | "desc"
  limit: number
  offset: number
}

export type DashboardRole = "operator" | "viewer" | null

export interface CityOption {
  id: string
  code: string
  name: string
}

export interface StoreOption {
  id: string
  code: string
  name: string
  locality: string
  city_id: string
  status: string
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------
export const analytics = {
  hasDashboardAccess: async () => {
    const { data, error } = await requireSupabase().rpc("has_dashboard_access")
    if (error) throw new AnalyticsError(error.message, error.code)
    return data === true
  },
  dataFreshness: async () => (await rpc<FreshnessRow>("analytics_data_freshness"))[0] ?? null,
  overview: async (s: AnalyticsScope) => (await rpc<OverviewRow>("analytics_overview", scopeArgs(s)))[0] ?? null,
  daily: (s: AnalyticsScope) => rpc<DailyRow>("analytics_daily", scopeArgs(s)),
  hourly: (s: AnalyticsScope) => rpc<HourlyRow>("analytics_hourly", scopeArgs(s)),
  cityPerformance: (s: AnalyticsScope) => rpc<CityPerformanceRow>("analytics_city_performance", scopeArgs(s)),
  storePerformance: (s: AnalyticsScope) => rpc<StorePerformanceRow>("analytics_store_performance", scopeArgs(s)),
  deliveryDistribution: (s: AnalyticsScope) => rpc<DeliveryDistributionRow>("analytics_delivery_distribution", scopeArgs(s)),
  ordersPage: (s: AnalyticsScope, p: OrdersPageParams) =>
    rpc<OrderPageRow>("analytics_orders_page", {
      ...scopeArgs(s),
      p_statuses: p.statuses,
      p_search: p.search.trim() || null,
      p_sort_by: p.sortBy,
      p_sort_dir: p.sortDir,
      p_limit: p.limit,
      p_offset: p.offset,
    }),

  // Role on the allowlist (migration 005). If 005 is not installed yet the
  // function does not exist: treat everyone as a viewer (simulator hidden).
  myRole: async (): Promise<DashboardRole> => {
    const { data, error } = await requireSupabase().rpc("my_dashboard_role")
    if (error) {
      if (error.code === "PGRST202" || error.code === "42883") return "viewer"
      throw new AnalyticsError(error.message, error.code)
    }
    return data === "operator" || data === "viewer" ? data : null
  },

  // Operator-only simulator (migration 005). The database enforces access.
  simulatorTick: (scenario: string, newOrders: number) =>
    jsonRpc<TickResult>("simulator_tick", { p_scenario: scenario, p_new_orders: newOrders }),
  simulatorStatus: () => jsonRpc<SimulatorStatus>("simulator_status"),
  simulatorReset: () =>
    jsonRpc<SimulatorStatus & { deleted_orders: number; deleted_stock_events: number; deleted_refunds: number }>("simulator_reset"),

  // Filter options: plain RLS-protected reads (members only)
  cities: async () => {
    const { data, error } = await requireSupabase().from("cities").select("id, code, name").order("name")
    if (error) throw new AnalyticsError(error.message, error.code)
    return (data ?? []) as CityOption[]
  },
  stores: async () => {
    const { data, error } = await requireSupabase()
      .from("dark_stores")
      .select("id, code, name, locality, city_id, status")
      .order("code")
    if (error) throw new AnalyticsError(error.message, error.code)
    return (data ?? []) as StoreOption[]
  },
}
