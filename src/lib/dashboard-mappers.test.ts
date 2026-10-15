import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { DailyRow, HourlyRow, OverviewRow, StorePerformanceRow } from "./analytics.ts"
import { buildKpis, dailyTrend, hourlyDemand, hourlyTrend, leaderboard, storeBreakdown, storeLabel } from "./dashboard-mappers.ts"

const overview = (o: Partial<OverviewRow>): OverviewRow => ({
  period_start: "2026-10-07", period_end: "2026-10-13", previous_start: "2026-09-30", previous_end: "2026-10-06",
  is_partial_period: false, total_orders: 0, delivered_orders: 0, cancelled_orders: 0, open_orders: 0,
  gmv_paise: 0, discount_paise: 0, refund_paise: 0, net_sales_paise: 0, aov_paise: null,
  cancellation_rate_pct: null, on_time_rate_pct: null, avg_delivery_minutes: null, p90_delivery_minutes: null,
  active_dark_stores: 0, prev_total_orders: 0, prev_delivered_orders: 0, prev_cancelled_orders: 0,
  prev_gmv_paise: 0, prev_net_sales_paise: 0, prev_aov_paise: null, prev_cancellation_rate_pct: null,
  prev_on_time_rate_pct: null, prev_avg_delivery_minutes: null, prev_active_dark_stores: 0, ...o,
})

const day = (d: Partial<DailyRow>): DailyRow => ({
  report_date: "2026-10-13", previous_date: "2026-10-06", is_partial_day: false, orders: 0, delivered_orders: 0,
  cancelled_orders: 0, gmv_paise: 0, net_sales_paise: 0, aov_paise: null, on_time_rate_pct: null,
  avg_delivery_minutes: null, prev_orders: 0, prev_gmv_paise: 0, prev_net_sales_paise: 0,
  prev_on_time_rate_pct: null, prev_avg_delivery_minutes: null, ...d,
})

describe("buildKpis", () => {
  it("converts paise to rupees and keeps previous-period values", () => {
    const k = buildKpis(
      overview({ total_orders: 1608, prev_total_orders: 1642, gmv_paise: 67403900, prev_gmv_paise: 70099500, aov_paise: 43196.5, on_time_rate_pct: 78.59, prev_on_time_rate_pct: 75.97 }),
      [],
    )
    const by = Object.fromEntries(k.map((m) => [m.id, m]))
    assert.equal(by.orders.value, 1608)
    assert.equal(by.orders.previous, 1642)
    assert.equal(by.gmv.value, 674039)
    assert.equal(by.gmv.previous, 700995)
    assert.equal(by.aov.value, 431.965)
    assert.equal(by.ontime.value, 78.59)
    assert.equal(by.delivery.goodDirection, "down")
    assert.equal(by.cancel.goodDirection, "down")
  })

  it("returns null (shown as —), not 0, when there is no data", () => {
    const k = buildKpis(overview({}), [])
    for (const m of k) assert.equal(m.value, null, m.id)
    for (const m of k) assert.equal(m.previous, null, m.id)
  })

  it("keeps the current value when only the previous period is empty", () => {
    const k = buildKpis(overview({ total_orders: 10, gmv_paise: 500000, prev_total_orders: 0 }), [])
    const orders = k.find((m) => m.id === "orders")!
    assert.equal(orders.value, 10)
    assert.equal(orders.previous, null)
  })

  it("derives the cancellation sparkline per day from server aggregates", () => {
    const k = buildKpis(overview({ total_orders: 30 }), [
      day({ delivered_orders: 9, cancelled_orders: 1 }),
      day({ delivered_orders: 0, cancelled_orders: 0 }), // no closed orders: skipped, not 0%
      day({ delivered_orders: 19, cancelled_orders: 1 }),
    ])
    assert.deepEqual(k.find((m) => m.id === "cancel")!.sparkline, [10, 5])
  })
})

describe("trend and hourly mappers", () => {
  it("daily trend pairs each day with its previous-period day", () => {
    assert.deepEqual(dailyTrend([day({ report_date: "2026-10-13", orders: 240, prev_orders: 228 })]), [
      { label: "13 Oct", current: 240, previous: 228 },
    ])
  })

  it("hourly trend aligns hours and fills missing previous hours with 0", () => {
    const h = (hour_ist: number, orders: number): HourlyRow => ({
      hour_ist, orders, avg_orders_per_day: orders, delivered_orders: 0, late_orders: 0, on_time_rate_pct: null, avg_delivery_minutes: null,
    })
    assert.deepEqual(hourlyTrend([h(9, 12), h(19, 30)], [h(19, 25)]), [
      { label: "09:00", current: 12, previous: 0 },
      { label: "19:00", current: 30, previous: 25 },
    ])
  })

  it("hourly demand uses counts for one day and the daily average otherwise", () => {
    const row: HourlyRow = { hour_ist: 7, orders: 70, avg_orders_per_day: 10, delivered_orders: 0, late_orders: 0, on_time_rate_pct: null, avg_delivery_minutes: null }
    assert.equal(hourlyDemand([row], 1)[0].orders, 70)
    assert.equal(hourlyDemand([row], 7)[0].orders, 10)
    assert.equal(hourlyDemand([row], 7)[0].hour, "07")
  })
})

describe("store mappers", () => {
  const store = (s: Partial<StorePerformanceRow>): StorePerformanceRow => ({
    store_id: "x", store_code: "BLR-01", store_name: "Koramangala Dark Store (synthetic)", city_name: "Bengaluru",
    store_status: "live", orders: 0, delivered_orders: 0, cancelled_orders: 0, gmv_paise: 0, net_sales_paise: 0,
    aov_paise: null, avg_fulfillment_minutes: null, avg_delivery_minutes: null, on_time_rate_pct: null,
    cancellation_rate_pct: null, fill_rate_pct: null, gmv_rank: 1, ...s,
  })

  it("builds a compact store label", () => {
    assert.equal(storeLabel("BLR-01", "Koramangala Dark Store (synthetic)"), "BLR-01 · Koramangala")
  })

  it("breakdown hides planned stores without orders but keeps live ones", () => {
    const rows = [store({ store_id: "a" }), store({ store_id: "b", store_status: "planned" })]
    assert.deepEqual(storeBreakdown(rows).map((r) => r.id), ["a"])
  })

  it("leaderboard ranks by GMV rank, skips stores without orders, keeps null metrics", () => {
    const rows = [
      store({ store_id: "b", orders: 5, gmv_paise: 100, gmv_rank: 2, avg_delivery_minutes: 8.5 }),
      store({ store_id: "a", orders: 9, gmv_paise: 900, gmv_rank: 1 }),
      store({ store_id: "z", orders: 0, gmv_rank: 3 }),
    ]
    const lb = leaderboard(rows)
    assert.deepEqual(lb.map((r) => r.id), ["a", "b"])
    assert.equal(lb[0].avgDeliveryMin, null)
    assert.equal(lb[1].gmv, 1)
  })
})
