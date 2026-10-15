// Pure mappers: analytics RPC rows -> the props the existing dashboard
// components already render. No aggregation of orders happens here; values
// are taken from server-side aggregates (only per-row ratios are derived).
// Relative imports with .ts extensions so `node --test` can run these directly.
import type {
  CityPerformanceRow, DailyRow, DeliveryDistributionRow, HourlyRow, OverviewRow, StorePerformanceRow,
} from "./analytics.ts"
import { formatIstDate } from "./dates.ts"
import type { BreakdownPoint, DeliveryBucket, HourlyPoint, KpiMetric, StoreRow, TrendPoint } from "../types/dashboard.ts"

const rupees = (paise: number | null | undefined) => (paise == null ? null : Number(paise) / 100)
const num = (v: number | null | undefined) => (v == null ? null : Number(v))
const defined = (xs: (number | null)[]) => xs.filter((x): x is number => x != null)

/** Short store label for chart axes: "BLR-01 · Koramangala" */
export function storeLabel(code: string, name: string): string {
  return `${code} · ${name.split(" Dark Store")[0]}`
}

export function buildKpis(o: OverviewRow, daily: DailyRow[]): KpiMetric[] {
  const hasOrders = Number(o.total_orders) > 0
  const hadOrders = Number(o.prev_total_orders) > 0
  const cur = <T,>(v: T) => (hasOrders ? v : null)
  const prev = <T,>(v: T) => (hadOrders ? v : null)
  return [
    {
      id: "orders", label: "Total Orders", format: "number", goodDirection: "up",
      value: cur(Number(o.total_orders)), previous: prev(Number(o.prev_total_orders)),
      hint: "All orders placed in the period (any status), by IST date",
      sparkline: daily.map((d) => Number(d.orders)),
    },
    {
      id: "gmv", label: "Gross Merchandise Value", format: "currency", goodDirection: "up",
      value: cur(rupees(o.gmv_paise)), previous: prev(rupees(o.prev_gmv_paise)),
      hint: "Item value of non-cancelled orders before discounts; excludes delivery fees",
      sparkline: daily.map((d) => Number(d.gmv_paise) / 100),
    },
    {
      id: "aov", label: "Avg Order Value", format: "currency", goodDirection: "up",
      value: rupees(o.aov_paise), previous: rupees(o.prev_aov_paise),
      hint: "GMV ÷ non-cancelled orders",
      sparkline: defined(daily.map((d) => rupees(d.aov_paise))),
    },
    {
      id: "delivery", label: "Avg Delivery Time", format: "minutes", goodDirection: "down",
      value: num(o.avg_delivery_minutes), previous: num(o.prev_avg_delivery_minutes),
      hint: "Placed → delivered, averaged over delivered orders",
      sparkline: defined(daily.map((d) => num(d.avg_delivery_minutes))),
    },
    {
      id: "ontime", label: "On-time Delivery", format: "percent", goodDirection: "up",
      value: num(o.on_time_rate_pct), previous: num(o.prev_on_time_rate_pct),
      hint: "Delivered within the store SLA (10 min) ÷ delivered orders",
      sparkline: defined(daily.map((d) => num(d.on_time_rate_pct))),
    },
    {
      id: "cancel", label: "Cancellation Rate", format: "percent", goodDirection: "down",
      value: num(o.cancellation_rate_pct), previous: num(o.prev_cancellation_rate_pct),
      hint: "Cancelled ÷ (delivered + cancelled); in-progress orders excluded",
      sparkline: defined(
        daily.map((d) => {
          const closed = Number(d.delivered_orders) + Number(d.cancelled_orders)
          return closed > 0 ? (100 * Number(d.cancelled_orders)) / closed : null
        }),
      ),
    },
  ]
}

/** Multi-day trend: current day vs the aligned previous-period day */
export function dailyTrend(daily: DailyRow[]): TrendPoint[] {
  return daily.map((d) => ({ label: formatIstDate(d.report_date), current: Number(d.orders), previous: Number(d.prev_orders) }))
}

/** Single-day trend: hour by hour vs the previous day */
export function hourlyTrend(current: HourlyRow[], previous: HourlyRow[]): TrendPoint[] {
  const prevByHour = new Map(previous.map((h) => [Number(h.hour_ist), Number(h.orders)]))
  return current.map((h) => ({
    label: `${String(h.hour_ist).padStart(2, "0")}:00`,
    current: Number(h.orders),
    previous: prevByHour.get(Number(h.hour_ist)) ?? 0,
  }))
}

/** Hour-of-day demand: raw counts for one day, daily average for longer ranges */
export function hourlyDemand(rows: HourlyRow[], days: number): HourlyPoint[] {
  return rows.map((h) => ({
    hour: String(h.hour_ist).padStart(2, "0"),
    orders: days === 1 ? Number(h.orders) : Number(h.avg_orders_per_day),
  }))
}

export function cityBreakdown(rows: CityPerformanceRow[]): BreakdownPoint[] {
  return rows.map((c) => ({ id: c.city_id, name: c.city_name, gmv: Number(c.gmv_paise) / 100, orders: Number(c.orders) }))
}

/** Stores shown in the breakdown: live stores, plus any store that has orders */
export function storeBreakdown(rows: StorePerformanceRow[]): BreakdownPoint[] {
  return rows
    .filter((s) => s.store_status === "live" || Number(s.orders) > 0)
    .map((s) => ({ id: s.store_id, name: storeLabel(s.store_code, s.store_name), gmv: Number(s.gmv_paise) / 100, orders: Number(s.orders) }))
}

export function leaderboard(rows: StorePerformanceRow[], limit = 6): StoreRow[] {
  return rows
    .filter((s) => Number(s.orders) > 0)
    .sort((a, b) => Number(a.gmv_rank) - Number(b.gmv_rank))
    .slice(0, limit)
    .map((s) => ({
      id: s.store_id,
      name: storeLabel(s.store_code, s.store_name),
      city: s.city_name,
      orders: Number(s.orders),
      gmv: Number(s.gmv_paise) / 100,
      avgDeliveryMin: num(s.avg_delivery_minutes),
      onTimePct: num(s.on_time_rate_pct),
    }))
}

export function deliveryBuckets(rows: DeliveryDistributionRow[]): DeliveryBucket[] {
  return rows.map((b) => ({ bucket: b.bucket_label, orders: Number(b.orders), withinSla: b.within_10_min }))
}
