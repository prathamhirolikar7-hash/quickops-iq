# QuickOps IQ · KPI Dictionary

Business definitions behind every number on the dashboard. All metrics are
computed **server-side** by the functions in
`supabase/migrations/003_analytics_functions.sql`. The browser never
aggregates raw orders.

## Conventions

| Topic | Rule |
|---|---|
| Reporting date | `orders.order_date`: the **IST (Asia/Kolkata) calendar date** of `placed_at`. An order placed at 00:30 IST counts on that IST day, even though it is the previous day in UTC. |
| Date range | Inclusive `p_start_date … p_end_date`, maximum 401 days. |
| Previous period | The same number of days immediately before the start date. Example: 7–13 Oct is compared with 30 Sep–6 Oct. |
| Partial period | `is_partial_period` / `is_partial_day` is true when the range includes today (IST): the day is not finished yet. |
| Filters | `p_city_id`, `p_store_id`; `NULL` = all. A store outside the chosen city returns zero orders. |
| Money | Integer **paise** (`bigint`) end to end; the frontend divides by 100 and formats INR (₹, lakh, crore). |
| Rates | Percent 0–100, rounded to 2 dp. **NULL when the denominator is 0** (shown as "—", never as a misleading 0%). |
| Durations | Minutes, rounded to 2 dp. |
| Joins | Every child table (refunds, items, delivery events) is pre-aggregated to **one row per order** before joining, so totals are never double-counted. |

## Order populations

| Population | Definition |
|---|---|
| All orders | Every order placed in the period (any status) |
| Valid orders | `status <> 'cancelled'` (delivered + still in progress) |
| Delivered orders | `status = 'delivered'` |
| Closed orders | `status in ('delivered', 'cancelled')` |
| Open orders | Any other status (in progress) |

## Executive Overview KPIs (`analytics_overview`)

| KPI | Formula | Population | Notes |
|---|---|---|---|
| Total orders | `count(*)` | All orders | |
| Delivered orders | `count(*)` | Delivered | |
| Cancelled orders | `count(*)` | `status = 'cancelled'` | |
| Open orders | `count(*)` | Open | Live operations |
| **GMV** | `Σ item_total_paise` | Valid orders | Merchandise value at selling price, **before** discounts; excludes delivery fees and cancelled orders. |
| Discounts | `Σ discount_paise` | Valid orders | |
| Refunds | `Σ refunds.amount_paise` where refund `status <> 'failed'` | Valid orders | Attributed to the order's date (cohort view), not the refund date. Refunds of cancelled orders are excluded because those orders are not in GMV. |
| **Net sales** | `GMV − discounts − refunds` | Valid orders | Merchandise revenue actually kept. Delivery fees excluded. |
| **AOV** | `GMV ÷ valid orders` | Valid orders | Paise, 2 dp |
| **Cancellation rate** | `cancelled ÷ (delivered + cancelled) × 100` | Closed orders | In-progress orders are excluded so a live "today" view is not diluted. |
| **On-time delivery rate** | `count(sla_met) ÷ delivered × 100` | Delivered | `sla_met = delivered_at <= sla_deadline_at` (deadline = placed + store SLA, 10 min) |
| **Avg delivery time** | `avg(delivery_seconds) ÷ 60` | Delivered | Placed → delivered |
| P90 delivery time | 90th percentile of `delivery_seconds` ÷ 60 | Delivered | Tail experience |
| **Active dark stores** | `count(distinct store_id)` | All orders | Stores that received at least one order in the period |

Every KPI above (except open orders and discounts/refunds) also has a
`prev_…` column for the previous period.

## Daily (`analytics_daily`) and hourly (`analytics_hourly`)

- **Daily:** one row per IST date in the range, **zero-filled**, with the
  aligned previous-period date (`previous_date = report_date − range length`)
  and its values, for overlay charts.
- **Hourly:** all 24 IST hours, zero-filled.
  - `avg_orders_per_day = orders ÷ days in range`
  - `late_orders` = delivered and not `sla_met`

## City (`analytics_city_performance`) and store (`analytics_store_performance`)

The same KPI formulas, grouped by city or store. Every city or store in scope
is listed, even with zero orders.

| Metric | Formula |
|---|---|
| GMV share | `city GMV ÷ Σ GMV of listed cities × 100` |
| Avg fulfilment time | `avg(packing_completed − placed_at)` over delivered orders: the store-controlled part |
| Fill rate | `Σ quantity_fulfilled ÷ Σ quantity × 100` over delivered orders' lines |
| GMV rank | `rank()` by GMV, descending |

## Delivery delay analysis (`analytics_delivery_stages`)

Population: delivered orders. Grouped by `overall` | `hour` | `weekday` | `city` | `store`.

| Stage | From → To |
|---|---|
| Queue | placed → picking_started |
| Picking | picking_started → picking_completed |
| Packing | picking_completed → packing_completed |
| Dispatch wait | packing_completed → dispatched (waiting for a rider) |
| Travel | dispatched → arrived_at_customer |
| Handover | arrived_at_customer → delivered |

The six stage averages add up to the average total delivery time (tested to within 0.05 min).

| Metric | Formula |
|---|---|
| Late orders | delivered and not `sla_met` |
| Late rate | late ÷ delivered × 100 |
| Avg minutes late | `avg(delivered_at − sla_deadline_at)` over late orders only |

`analytics_delivery_distribution` buckets delivered orders by minutes:
<6, 6–8, 8–10, 10–12, 12–15, 15–20, 20+. Always 7 rows; `share_pct` is NULL if
there are no deliveries.

## Inventory

| Metric | Function | Definition |
|---|---|---|
| SKUs tracked | `analytics_inventory_status` | Store × product rows in `inventory` |
| In stock / out of stock | 〃 | `quantity_on_hand > 0` / `= 0` (current, not date-filtered) |
| Low stock | 〃 | `0 < quantity_on_hand <= reorder_level` |
| Availability | 〃 | in-stock SKUs ÷ SKUs tracked × 100 |
| Stockout events | `analytics_stockouts` | Ledger movements leaving a SKU at **0** (`inventory_events.quantity_after = 0`), within the IST date range |
| Short-picked lines / units | 〃 | Order lines with `quantity_fulfilled < quantity`, in orders that reached picking |
| Lost sales | 〃 | `Σ (quantity − quantity_fulfilled) × unit_price_paise` |

## Orders explorer (`analytics_orders_page`)

- **Filters:** date, city, store, status list.
- **Search:** case-insensitive, literal match on order number, store code, name or locality. Wildcards are escaped and input is limited to 64 characters.
- **Sort:** `placed_at` | `order_number` | `total` | `delivery_time` | `status` | `store`, `asc`/`desc`.
- **Paging:** `p_limit` is clamped to 1–100.
  - Each row carries `total_count` (all matching rows) and `row_number`.
  - Order id breaks ties, so pages never overlap or skip rows.
  - An empty array means `total_count = 0`.

## Access control

All functions are `SECURITY INVOKER`, so RLS from migration 002 still applies.
Each function first checks dashboard approval:

| Caller | Result |
|---|---|
| Anonymous | `permission denied` (no EXECUTE grant) |
| Signed in, not approved | error `42501` "QuickOps IQ dashboard access required" |
| Approved member | Results |
| postgres / service_role | Results (server-side only; these roles already bypass RLS) |
