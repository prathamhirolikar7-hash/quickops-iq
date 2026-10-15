// =============================================================================
// QuickOps IQ · Deterministic synthetic dataset generator
// =============================================================================
// Pure function: (seed, orders, days, endDate) -> identical rows every time.
// No I/O, no clock, no Math.random().
//
// Pipeline
//   1. Reference data   cities, dark stores, products, riders
//   2. Demand           exactly N orders spread across store x day x hour slots
//                       (weekday/weekend, peak hours, festivals, rain, growth)
//   3. Order skeletons  basket, payment, fulfilment timeline, planned cancels
//   4. Stock ledger     chronological per-store simulation: opening stock,
//                       daily restocks, sales at pick time, returns, expiry,
//                       damage. Lines short on stock are partially fulfilled;
//                       orders with nothing in stock are cancelled.
//   5. Riders           earliest-free rider per store, traffic, rain
//   6. Finalise         statuses, timelines, money, refunds
// =============================================================================
import {
  BRANDS, CANCEL_PLAN, CATALOG, CITIES, DEFAULTS, DOW_FACTOR, FIRST_NAMES, FRESH_CATEGORIES,
  HOUR_WEIGHTS, IST_OFFSET_MS, LAST_INITIALS, LINES_DIST, PAYMENT_MIX, PEAK_TRAFFIC, SLA_MINUTES,
  SPECIAL_DAYS, STORES, WEEKEND_HOUR_ADJUST,
} from "./config.mjs"
import { rng, uuidFor } from "./random.mjs"

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const STAGE_RANK = { placed: 0, confirmed: 1, picking: 2, packed: 3, out_for_delivery: 4, delivered: 5 }
const CANCEL_ACTOR = {
  customer_request: "customer", payment_failed: "system", item_unavailable: "store",
  store_closed: "store", address_issue: "rider",
}

export function generateDataset(options = {}) {
  const opt = { ...DEFAULTS, ...options }
  const S = opt.seed
  const id = (...p) => uuidFor(S, ...p)
  const R = (...p) => rng(S, ...p)

  // ---- time window (UTC ms, aligned to IST midnight) ----
  const [ey, em, ed] = opt.endDate.split("-").map(Number)
  const endMs = Date.UTC(ey, em - 1, ed + 1) - IST_OFFSET_MS // midnight IST after the last day
  const startMs = endMs - opt.days * DAY
  const setupMs = startMs - 120 * DAY
  const iso = (ms) => new Date(ms).toISOString()
  const ist = (ms) => new Date(ms + IST_OFFSET_MS)
  const istDate = (ms) => ist(ms).toISOString().slice(0, 10)
  const istHour = (ms) => ist(ms).getUTCHours()
  const istDow = (ms) => ist(ms).getUTCDay()
  const istMonth = (ms) => ist(ms).getUTCMonth() + 1

  // ===========================================================================
  // 1. Reference data
  // ===========================================================================
  const cityRows = CITIES.map((c) => ({
    id: id("city", c.code), code: c.code, name: c.name, state: c.state, timezone: "Asia/Kolkata",
    is_active: true, created_at: iso(setupMs), updated_at: iso(setupMs),
  }))
  const cityByCode = new Map(CITIES.map((c) => [c.code, { ...c, id: id("city", c.code) }]))

  const storeRows = STORES.map((s) => ({
    id: id("store", s.code), city_id: id("city", s.city), code: s.code,
    name: `${s.locality} Dark Store (synthetic)`, locality: s.locality,
    latitude: s.lat, longitude: s.lng, status: s.status ?? "live",
    sla_minutes: SLA_MINUTES[s.code] ?? SLA_MINUTES.default, opened_on: s.opened,
    created_at: iso(setupMs), updated_at: iso(setupMs),
  }))
  const liveStores = STORES.filter((s) => (s.status ?? "live") === "live").map((s) => ({
    ...s, id: id("store", s.code), city: cityByCode.get(s.city),
    sla: SLA_MINUTES[s.code] ?? SLA_MINUTES.default,
  }))

  const products = []
  CATALOG.forEach(([category, catWeight, brandIdx, items], catIdx) => {
    const catCode = category.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase()
    const raw = items.map((_, i) => (1 / (1 + 0.08 * i)) * R("popularity", category, i).between(0.6, 1.4))
    const rawSum = raw.reduce((a, b) => a + b, 0)
    items.forEach(([subcategory, name, unit, mrp], i) => {
      const r = R("product", category, name)
      const mrpPaise = mrp * 100
      const discount = r.chance(0.45) ? 0 : r.between(0.03, 0.15)
      const selling = Math.min(mrpPaise, Math.max(100, Math.round((mrpPaise * (1 - discount)) / 100) * 100))
      const sku = `SYN-${catCode}-${String(catIdx + 1).padStart(2, "0")}${String(i + 1).padStart(2, "0")}`
      products.push({
        row: {
          id: id("product", sku), sku, name, category, subcategory,
          brand: `${BRANDS[brandIdx]} (synthetic)`, unit_label: unit,
          mrp_paise: mrpPaise, selling_price_paise: selling, is_active: true,
          created_at: iso(setupMs), updated_at: iso(setupMs),
        },
        sku, weight: (catWeight * raw[i]) / rawSum, fresh: FRESH_CATEGORIES.has(category), core: i < 2,
        price: selling, mrp: mrpPaise,
      })
    })
  })

  // Rain days per city (monsoon-weighted). Slows riders, lifts demand slightly.
  const MONSOON = { 6: 0.8, 7: 1, 8: 0.9, 9: 0.65, 10: 0.25 }
  const rainy = new Map()
  const isRainy = (cityCode, dayIdx) => {
    const key = `${cityCode}|${dayIdx}`
    if (!rainy.has(key)) {
      const c = cityByCode.get(cityCode)
      const p = c.rainBase * (MONSOON[istMonth(startMs + dayIdx * DAY)] ?? 0.05)
      rainy.set(key, R("rain", cityCode, dayIdx).chance(p))
    }
    return rainy.get(key)
  }

  const riderRows = []
  const activeRiders = new Map()
  for (const s of liveStores) {
    const count = 5 + Math.round(s.weight * 2)
    const active = []
    for (let i = 0; i < count; i++) {
      const r = R("rider", s.code, i)
      const status = i < 4 ? "active" : r.weighted([["active", 0.8], ["on_leave", 0.12], ["inactive", 0.08]])
      const joinedMs = startMs - r.int(20, 700) * DAY
      const row = {
        id: id("rider", s.code, i), store_id: s.id,
        full_name: `${r.pick(FIRST_NAMES)} ${r.pick(LAST_INITIALS)}. (synthetic)`,
        employment_type: r.weighted([["gig", 0.55], ["full_time", 0.3], ["part_time", 0.15]]),
        vehicle_type: r.weighted([["e_bike", 0.45], ["scooter", 0.3], ["motorbike", 0.2], ["bicycle", 0.05]]),
        status, joined_on: istDate(joinedMs), created_at: iso(joinedMs), updated_at: iso(joinedMs),
      }
      riderRows.push(row)
      if (status === "active") active.push(row)
    }
    activeRiders.set(s.code, active)
  }

  // Assortment: each store carries ~93% of the catalogue (core items always)
  const assortment = new Map()
  for (const s of liveStores) {
    const carried = products.filter((p) => p.core || R("assortment", s.code, p.sku).chance(0.93))
    const cum = []
    let acc = 0
    for (const p of carried) cum.push((acc += p.weight))
    assortment.set(s.code, { carried, cum })
  }

  // ===========================================================================
  // 2. Demand: allocate exactly N orders to store x day x hour slots
  // ===========================================================================
  const slots = []
  for (let d = 0; d < opt.days; d++) {
    const dayStart = startMs + d * DAY
    const dow = istDow(dayStart)
    const weekend = dow === 0 || dow === 6
    const special = SPECIAL_DAYS[istDate(dayStart)]
    const growth = 1 + (0.15 * d) / opt.days
    for (const s of liveStores) {
      const festival = special ? (special[s.city.code] ?? special.all ?? 1) : 1
      const noise = R("day-noise", s.code, d).between(0.85, 1.15)
      const rain = isRainy(s.city.code, d) ? 1.08 : 1
      const base = s.weight * DOW_FACTOR[dow] * festival * noise * growth * rain
      for (let h = 0; h < 24; h++) {
        const hw = HOUR_WEIGHTS[h] * (weekend ? (WEEKEND_HOUR_ADJUST[h] ?? 1) : 1)
        if (hw > 0) slots.push({ s, d, h, w: base * hw * R("hour-noise", s.code, d, h).between(0.8, 1.2) })
      }
    }
  }
  // Deterministic stochastic rounding (unbiased for low-demand hours), then
  // nudge the total to exactly N.
  const totalW = slots.reduce((a, x) => a + x.w, 0)
  let assigned = 0
  slots.forEach((x, i) => {
    x.exact = (opt.orders * x.w) / totalW
    x.count = Math.floor(x.exact + R("alloc", x.s.code, x.d, x.h).next())
    x.idx = i
    assigned += x.count
  })
  const delta = opt.orders - assigned
  if (delta !== 0) {
    const gap = (x) => x.exact - x.count // >0: under-allocated
    const ranked = [...slots].sort((a, b) => (delta > 0 ? gap(b) - gap(a) : gap(a) - gap(b)) || a.idx - b.idx)
    for (let k = 0, left = Math.abs(delta); left > 0; k = (k + 1) % ranked.length) {
      const x = ranked[k]
      if (delta > 0) { x.count++; left-- } else if (x.count > 0) { x.count--; left-- }
    }
  }

  // ===========================================================================
  // 3. Order skeletons
  // ===========================================================================
  const orders = []
  for (const x of slots) {
    for (let j = 0; j < x.count; j++) {
      const key = `${x.s.code}|${x.d}|${x.h}|${j}`
      const second = Math.floor(R("slot", key).next() * 3600)
      orders.push({ key, store: x.s, dayIdx: x.d, placed: startMs + x.d * DAY + x.h * HOUR + second * SEC })
    }
  }
  orders.sort((a, b) => a.placed - b.placed || (a.key < b.key ? -1 : 1))

  const qtyDist = (price) =>
    price <= 6000 ? [[1, 0.68], [2, 0.22], [3, 0.07], [4, 0.03]]
      : price <= 20000 ? [[1, 0.85], [2, 0.13], [3, 0.02]]
        : [[1, 0.95], [2, 0.05]]

  orders.forEach((o, i) => {
    const r = R("order", o.key)
    o.number = `SYN-${String(i + 1).padStart(6, "0")}`
    o.id = id("order", o.number)
    o.payment = r.weighted(PAYMENT_MIX)
    const hour = istHour(o.placed)
    const busy = PEAK_TRAFFIC[hour] ?? 1

    // Basket
    const { carried, cum } = assortment.get(o.store.code)
    const target = Math.min(12, Math.max(1, Math.round(r.weighted(LINES_DIST) * o.store.city.basket * r.between(0.9, 1.1))))
    const chosen = new Map()
    for (let t = 0; chosen.size < target && t < target * 4; t++) {
      const p = carried[r.fromCumulative(cum)]
      if (!chosen.has(p.sku)) chosen.set(p.sku, { p, qty: r.weighted(qtyDist(p.price)), fulfilled: 0 })
    }
    o.lines = [...chosen.values()]

    // Planned (non-stock) cancellation
    o.plan = null
    for (const c of CANCEL_PLAN) {
      if (c.prepaidOnly && o.payment === "cod") continue
      if (r.chance(c.p)) {
        o.plan = c
        break
      }
    }

    // Store-side timeline
    o.confirm = o.placed + r.int(3, 20) * SEC
    o.pickStart = o.confirm + Math.round(r.int(5, 30) * busy) * SEC + (r.chance(0.06) ? r.int(60, 200) * SEC : 0)
    o.pickDone = o.pickStart + (o.lines.length * r.int(12, 20) + r.int(10, 40)) * SEC
    o.packDone = o.pickDone + r.int(20, 50) * SEC
    o.distanceKm = 0.4 + 2.2 * r.next() ** 1.4
    o.handover = r.int(20, 90) * SEC
    o.coupon = r.chance(0.22) ? r.between(0.05, 0.15) : 0
  })

  // ===========================================================================
  // 4. Stock ledger (chronological per store)
  // ===========================================================================
  const inventoryRows = []
  const inventoryEvents = []
  const ordersByStore = new Map(liveStores.map((s) => [s.code, []]))
  for (const o of orders) ordersByStore.get(o.store.code).push(o)

  const nextReconciliation = (ms) => {
    // 05:50 IST on the first day where that moment is after ms
    const dayStart = Math.floor((ms + IST_OFFSET_MS) / DAY) * DAY - IST_OFFSET_MS
    let t = dayStart + 5 * HOUR + 50 * MIN
    while (t <= ms) t += DAY
    return t
  }

  for (const s of liveStores) {
    const { carried } = assortment.get(s.code)
    const storeOrders = ordersByStore.get(s.code)

    // Par level from actual demand at this store
    const demand = new Map(carried.map((p) => [p.sku, 0]))
    for (const o of storeOrders) for (const l of o.lines) demand.set(l.p.sku, demand.get(l.p.sku) + l.qty)
    const par = new Map()
    for (const p of carried) {
      const r = R("par", s.code, p.sku)
      const daily = demand.get(p.sku) / opt.days
      const level = r.chance(0.06)
        ? Math.max(2, Math.ceil(daily * r.between(1.0, 1.5))) // chronically under-stocked SKU
        : Math.max(4, Math.ceil(daily * r.between(3.0, 5.0)) + 2)
      par.set(p.sku, level)
    }

    const ev = []
    const RANK = { restock: 0, sale: 1, return: 2, expiry: 3, damage: 4 }
    for (const p of carried) ev.push({ t: startMs - HOUR, kind: "restock", p, tie: p.sku })
    for (let d = 0; d < opt.days; d++) {
      const dayStart = startMs + d * DAY
      for (const p of carried) {
        if (!R("restock-skip", s.code, p.sku, d).chance(0.03)) ev.push({ t: dayStart + 6 * HOUR, kind: "restock", p, tie: p.sku })
        if (p.fresh && R("topup", s.code, p.sku, d).chance(0.6)) ev.push({ t: dayStart + 15 * HOUR, kind: "restock", p, tie: p.sku })
        if (p.fresh && R("expiry", s.code, p.sku, d).chance(0.08)) ev.push({ t: dayStart + 22 * HOUR + 30 * MIN, kind: "expiry", p, tie: p.sku })
      }
      const dr = R("damage", s.code, d)
      if (dr.chance(0.35)) {
        const p = dr.pick(carried)
        ev.push({ t: dayStart + dr.int(7 * 60, 22 * 60) * MIN, kind: "damage", p, tie: p.sku })
      }
    }
    for (const o of storeOrders) {
      const stage = o.plan?.stage
      if (stage === "placed" || stage === "confirmed") continue
      ev.push({ t: o.pickDone, kind: "sale", o, tie: o.number })
      if (stage === "packed") ev.push({ t: o.packDone + 10 * MIN, kind: "return", o, type: "adjustment", tie: o.number })
      if (stage === "out_for_delivery") ev.push({ t: nextReconciliation(o.packDone + 2 * HOUR), kind: "return", o, type: "customer_return", tie: o.number })
    }
    ev.sort((a, b) => a.t - b.t || RANK[a.kind] - RANK[b.kind] || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0))

    const stock = new Map(carried.map((p) => [p.sku, 0]))
    const lastRestock = new Map()
    const lastEvent = new Map()
    const push = (p, type, change, t, orderId = null) => {
      const after = stock.get(p.sku) + change
      stock.set(p.sku, after)
      lastEvent.set(p.sku, t)
      inventoryEvents.push({
        store_id: s.id, product_id: p.row.id, event_type: type, quantity_change: change,
        quantity_after: after, order_id: orderId, occurred_at: iso(t), created_at: iso(t),
        // Keeps the exact simulation order for same-second events (ledger order)
        _sort: `${String(t).padStart(15, "0")}|${s.code}|${String(inventoryEvents.length).padStart(8, "0")}`,
      })
    }
    for (const e of ev) {
      if (e.kind === "restock") {
        const q = par.get(e.p.sku) - stock.get(e.p.sku)
        if (q > 0) {
          push(e.p, "restock", q, e.t)
          lastRestock.set(e.p.sku, e.t)
        }
      } else if (e.kind === "sale") {
        let total = 0
        for (const l of e.o.lines) {
          l.fulfilled = Math.min(l.qty, stock.get(l.p.sku))
          total += l.fulfilled
          if (l.fulfilled > 0) push(l.p, "sale", -l.fulfilled, e.t, e.o.id)
        }
        if (total === 0) e.o.stockCancelled = true
      } else if (e.kind === "return") {
        if (e.o.stockCancelled) continue
        for (const l of e.o.lines) if (l.fulfilled > 0) push(l.p, e.type, l.fulfilled, e.t)
      } else {
        const q = Math.min(stock.get(e.p.sku), e.kind === "expiry" ? R("expiry-qty", s.code, e.p.sku, e.t).int(1, 2) : 1)
        if (q > 0) push(e.p, e.kind, -q, e.t)
      }
    }

    for (const p of carried) {
      inventoryRows.push({
        id: id("inventory", s.code, p.sku), store_id: s.id, product_id: p.row.id,
        quantity_on_hand: stock.get(p.sku), reorder_level: Math.max(1, Math.ceil(par.get(p.sku) * 0.3)),
        last_restocked_at: lastRestock.has(p.sku) ? iso(lastRestock.get(p.sku)) : null,
        created_at: iso(startMs - HOUR), updated_at: iso(lastEvent.get(p.sku) ?? startMs - HOUR),
      })
    }
  }

  // ===========================================================================
  // 5. Riders: earliest-free active rider at each store
  // ===========================================================================
  for (const s of liveStores) {
    const fleet = activeRiders.get(s.code)
    const busyUntil = new Map(fleet.map((r) => [r.id, 0]))
    const queue = ordersByStore.get(s.code)
      .filter((o) => !o.stockCancelled && (!o.plan || STAGE_RANK[o.plan.stage] >= STAGE_RANK.out_for_delivery))
      .sort((a, b) => a.packDone - b.packDone || (a.number < b.number ? -1 : 1))
    for (const o of queue) {
      const r = R("ride", o.key)
      let rider = fleet[0]
      for (const f of fleet) if (busyUntil.get(f.id) < busyUntil.get(rider.id)) rider = f
      const free = busyUntil.get(rider.id)
      o.rider = rider
      o.riderAssigned = Math.max(o.pickStart + 20 * SEC, free)
      o.dispatched = Math.max(o.packDone, free) + r.int(10, 40) * SEC
      const peak = PEAK_TRAFFIC[istHour(o.dispatched)] ?? 1
      const rain = isRainy(s.city.code, o.dayIdx) ? 1.3 : 1
      const speedKmh = (27 * r.between(0.85, 1.15)) / s.city.traffic / peak / rain
      const travel = Math.round((o.distanceKm / speedKmh) * 3600 + r.int(15, 60)) * SEC
      o.arrived = o.dispatched + travel
      if (o.plan?.stage === "out_for_delivery") {
        o.failed = o.arrived + r.int(180, 480) * SEC
        busyUntil.set(rider.id, o.failed + Math.round(travel * 0.9))
      } else {
        o.delivered = o.arrived + o.handover
        busyUntil.set(rider.id, o.delivered + Math.round(travel * 0.9))
      }
    }
  }

  // ===========================================================================
  // 6. Finalise orders, items, status history, delivery timeline, refunds
  // ===========================================================================
  const orderRows = []
  const itemRows = []
  const statusEvents = []
  const deliveryEvents = []
  const refundRows = []

  for (const o of orders) {
    const r = R("finalise", o.key)
    const itemTotal = o.lines.reduce((a, l) => a + l.qty * l.p.price, 0)
    const discount = o.coupon > 0 && itemTotal >= 19900 ? Math.min(10000, Math.round((itemTotal * o.coupon) / 100) * 100) : 0
    const deliveryFee = itemTotal < 19900 ? 2500 : 0
    const total = itemTotal - discount + deliveryFee

    // Outcome
    let status = "delivered", reason = null, cancelledAt = null, reached
    if (o.plan?.stage === "placed") {
      status = "cancelled"; reason = o.plan.reason; reached = "placed"
      cancelledAt = o.placed + (reason === "payment_failed" ? r.int(60, 180) : r.int(20, 120)) * SEC
    } else if (o.plan?.stage === "confirmed") {
      status = "cancelled"; reason = o.plan.reason; reached = "confirmed"
      cancelledAt = o.confirm + r.int(10, 60) * SEC
    } else if (o.stockCancelled) {
      status = "cancelled"; reason = "item_unavailable"; reached = "picking"
      cancelledAt = o.pickDone + r.int(20, 90) * SEC
    } else if (o.plan?.stage === "packed") {
      status = "cancelled"; reason = o.plan.reason; reached = "packed"
      cancelledAt = o.packDone + r.int(1, 5) * MIN
    } else if (o.plan?.stage === "out_for_delivery") {
      status = "cancelled"; reason = o.plan.reason; reached = "out_for_delivery"
      cancelledAt = o.failed
    } else {
      reached = "delivered"
    }
    const reach = STAGE_RANK[reached]

    // Status history (valid transitions only)
    const path = [["placed", o.placed, "customer"]]
    if (reach >= 1) path.push(["confirmed", o.confirm, "system"])
    if (reach >= 2) path.push(["picking", o.pickStart, "store"])
    if (reach >= 3) path.push(["packed", o.packDone, "store"])
    if (reach >= 4) path.push(["out_for_delivery", o.dispatched, "rider"])
    if (status === "delivered") path.push(["delivered", o.delivered, "rider"])
    else path.push(["cancelled", cancelledAt, CANCEL_ACTOR[reason]])
    path.forEach(([to, t, actor], i) => {
      statusEvents.push({
        order_id: o.id, from_status: i === 0 ? null : path[i - 1][0], to_status: to, actor,
        occurred_at: iso(t), created_at: iso(t),
      })
    })

    // Fulfilment timeline
    const de = (type, t, riderId = null) => deliveryEvents.push({
      order_id: o.id, rider_id: riderId, event_type: type, occurred_at: iso(t), created_at: iso(t),
    })
    if (reach >= 2) {
      de("picking_started", o.pickStart)
      de("picking_completed", o.pickDone)
    }
    if (reach >= 3) de("packing_completed", o.packDone)
    if (reach >= 4) {
      de("rider_assigned", o.riderAssigned, o.rider.id)
      de("dispatched", o.dispatched, o.rider.id)
      de("arrived_at_customer", o.arrived, o.rider.id)
      if (status === "delivered") de("delivered", o.delivered, o.rider.id)
      else de("delivery_failed", o.failed, o.rider.id)
    }

    const lastT = status === "delivered" ? o.delivered : cancelledAt
    orderRows.push({
      id: o.id, order_number: o.number, store_id: o.store.id, city_id: o.store.city.id,
      rider_id: reach >= 4 ? o.rider.id : null, status, payment_method: o.payment,
      item_total_paise: itemTotal, discount_paise: discount, delivery_fee_paise: deliveryFee,
      placed_at: iso(o.placed), sla_deadline_at: iso(o.placed + o.store.sla * MIN),
      delivered_at: status === "delivered" ? iso(o.delivered) : null,
      cancelled_at: cancelledAt ? iso(cancelledAt) : null, cancellation_reason: reason,
      created_at: iso(o.placed), updated_at: iso(lastT),
    })
    for (const l of o.lines) {
      itemRows.push({
        id: id("order_item", o.number, l.p.sku), order_id: o.id, product_id: l.p.row.id,
        quantity: l.qty, quantity_fulfilled: l.fulfilled, unit_mrp_paise: l.p.mrp, unit_price_paise: l.p.price,
        created_at: iso(o.placed),
      })
    }

    // Refunds: never more than the amount paid (total_paise)
    let remaining = total
    let n = 0
    // Mandatory refunds (cancellation, missing items) always exist. Optional
    // goodwill refunds are skipped if they would start after the data window.
    const refund = (amount, why, initiated, minH, maxH, mandatory = false) => {
      const amt = Math.min(amount, remaining)
      if (amt <= 0 || (!mandatory && initiated > endMs)) return
      remaining -= amt
      const processed = initiated + r.int(minH * 60, maxH * 60) * MIN
      const done = processed <= endMs
      refundRows.push({
        id: id("refund", o.number, n++), order_id: o.id, amount_paise: amt, reason: why,
        status: done ? "processed" : "initiated", initiated_at: iso(initiated),
        processed_at: done ? iso(processed) : null, created_at: iso(initiated), updated_at: iso(done ? processed : initiated),
      })
    }
    if (status === "cancelled") {
      if (o.payment !== "cod" && reason !== "payment_failed") refund(total, "order_cancelled", cancelledAt + MIN, 2, 72, true)
    } else {
      const shortfall = o.lines.reduce((a, l) => a + (l.qty - l.fulfilled) * l.p.price, 0)
      if (shortfall > 0) refund(shortfall, "item_missing", o.delivered + 2 * MIN, 1, 6, true)
      const freshLine = o.lines.find((l) => l.p.fresh && l.fulfilled > 0)
      if (r.chance(freshLine ? 0.03 : 0.012)) {
        const line = freshLine ?? o.lines.find((l) => l.fulfilled > 0)
        if (line) refund(line.p.price, freshLine ? "quality_issue" : "item_damaged", o.delivered + r.int(1, 30) * HOUR, 2, 48)
      }
      const lateBy = o.delivered - (o.placed + o.store.sla * MIN)
      if (lateBy > 0 && r.chance(0.2)) refund(lateBy > 5 * MIN ? 5000 : 2500, "late_delivery", o.delivered + r.int(10, 60) * MIN, 1, 4)
    }
  }

  const byTime = (a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0)
  inventoryEvents.sort((a, b) => (a._sort < b._sort ? -1 : a._sort > b._sort ? 1 : 0))
  for (const e of inventoryEvents) delete e._sort
  statusEvents.sort(byTime)
  deliveryEvents.sort(byTime)

  return {
    meta: { ...opt, windowStart: iso(startMs), windowEnd: iso(endMs) },
    tables: {
      cities: cityRows,
      dark_stores: storeRows,
      products: products.map((p) => p.row),
      inventory: inventoryRows,
      riders: riderRows,
      orders: orderRows,
      order_items: itemRows,
      inventory_events: inventoryEvents,
      order_status_events: statusEvents,
      delivery_events: deliveryEvents,
      refunds: refundRows,
    },
  }
}
