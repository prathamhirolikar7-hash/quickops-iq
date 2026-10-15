-- =============================================================================
-- QuickOps IQ · Synthetic data-quality checks (READ-ONLY)
-- =============================================================================
-- One row per rule. Every row must show violations = 0.
-- Safe to run any time in the Supabase SQL Editor; it only SELECTs.
-- The seed loader runs this same query before committing and rolls back if
-- any check fails.
-- =============================================================================
with
oi as (
  select order_id, sum(line_total_paise) as line_sum, count(*) as n
  from public.order_items group by order_id
),
rf as (
  select order_id, sum(amount_paise) filter (where status <> 'failed') as refunded
  from public.refunds group by order_id
),
ledger as (
  select e.store_id, e.product_id, e.quantity_after,
         sum(e.quantity_change) over (partition by e.store_id, e.product_id order by e.occurred_at, e.id
                                      rows between unbounded preceding and current row) as running,
         row_number() over (partition by e.store_id, e.product_id order by e.occurred_at desc, e.id desc) as rn_desc
  from public.inventory_events e
),
sales as (
  select order_id, product_id, -sum(quantity_change) as qty
  from public.inventory_events where event_type = 'sale' group by order_id, product_id
),
se as (
  select order_id, from_status, to_status, occurred_at,
         lag(to_status) over (partition by order_id order by occurred_at, id) as prev_to,
         row_number() over (partition by order_id order by occurred_at, id) as rn,
         row_number() over (partition by order_id order by occurred_at desc, id desc) as rn_desc
  from public.order_status_events
),
dt as (
  select order_id,
         max(occurred_at) filter (where event_type = 'picking_started')     as ps,
         max(occurred_at) filter (where event_type = 'picking_completed')   as pc,
         max(occurred_at) filter (where event_type = 'packing_completed')   as pk,
         max(occurred_at) filter (where event_type = 'rider_assigned')      as ra,
         max(occurred_at) filter (where event_type = 'dispatched')          as di,
         max(occurred_at) filter (where event_type = 'arrived_at_customer') as ar,
         max(occurred_at) filter (where event_type in ('delivered', 'delivery_failed')) as fin,
         count(*) filter (where event_type = 'delivered') as n_delivered,
         count(*) as n
  from public.delivery_events group by order_id
)
select check_no, check_name, violations from (
  select 1 as check_no, 'orders: item_total_paise = sum of order_items line totals' as check_name, count(*) as violations
    from public.orders o left join oi on oi.order_id = o.id where coalesce(oi.line_sum, 0) <> o.item_total_paise
  union all select 2, 'orders: every order has at least one item', count(*)
    from public.orders o left join oi on oi.order_id = o.id where oi.n is null
  union all select 3, 'order_items: unit price and MRP match the product catalogue', count(*)
    from public.order_items i join public.products p on p.id = i.product_id
    where i.unit_price_paise <> p.selling_price_paise or i.unit_mrp_paise <> p.mrp_paise
  union all select 4, 'refunds: total refunded <= amount paid (orders.total_paise)', count(*)
    from public.orders o join rf on rf.order_id = o.id where rf.refunded > o.total_paise
  union all select 5, 'refunds: only on delivered or cancelled orders', count(*)
    from public.refunds r join public.orders o on o.id = r.order_id where o.status not in ('delivered', 'cancelled')
  union all select 6, 'refunds: initiated after the order was delivered or cancelled', count(*)
    from public.refunds r join public.orders o on o.id = r.order_id
    where r.initiated_at < coalesce(o.delivered_at, o.cancelled_at)
  union all select 7, 'refunds: prepaid cancellations refunded in full', count(*)
    from public.orders o left join rf on rf.order_id = o.id
    where o.status = 'cancelled' and o.payment_method <> 'cod' and o.cancellation_reason <> 'payment_failed'
      and coalesce(rf.refunded, 0) <> o.total_paise
  union all select 8, 'refunds: short-picked delivered orders have an item_missing refund', count(*)
    from public.orders o
    where o.status = 'delivered'
      and exists (select 1 from public.order_items i where i.order_id = o.id and i.quantity_fulfilled < i.quantity)
      and not exists (select 1 from public.refunds r where r.order_id = o.id and r.reason = 'item_missing')
  union all select 9, 'inventory ledger: running sum of changes = quantity_after', count(*)
    from ledger where running <> quantity_after
  union all select 10, 'inventory: quantity_on_hand = latest ledger balance', count(*)
    from public.inventory i
    left join ledger l on l.store_id = i.store_id and l.product_id = i.product_id and l.rn_desc = 1
    where coalesce(l.quantity_after, 0) <> i.quantity_on_hand
  union all select 11, 'inventory: sale events = fulfilled quantity for every order line', count(*)
    from public.order_items i
    full join sales s on s.order_id = i.order_id and s.product_id = i.product_id
    where coalesce(s.qty, 0) <> coalesce(i.quantity_fulfilled, -1)
  union all select 12, 'status history: starts with placed at orders.placed_at', count(*)
    from public.orders o left join se on se.order_id = o.id and se.rn = 1
    where se.to_status is distinct from 'placed' or se.occurred_at is distinct from o.placed_at
  union all select 13, 'status history: ends at the current order status', count(*)
    from public.orders o left join se on se.order_id = o.id and se.rn_desc = 1
    where se.to_status is distinct from o.status
  union all select 14, 'status history: each from_status = previous to_status', count(*)
    from se where from_status is distinct from prev_to
  union all select 15, 'delivery timeline: milestones in chronological order', count(*)
    from dt
    where not coalesce(ps <= pc
                       and (pk is null or pc <= pk)
                       and (di is null or (pk <= di and ra <= di and di <= ar and ar <= fin)), false)
  union all select 16, 'delivery timeline: delivered orders have all 7 milestones', count(*)
    from public.orders o left join dt on dt.order_id = o.id where o.status = 'delivered' and coalesce(dt.n, 0) <> 7
  union all select 17, 'delivery timeline: delivered event time = orders.delivered_at', count(*)
    from public.orders o join public.delivery_events d on d.order_id = o.id and d.event_type = 'delivered'
    where d.occurred_at <> o.delivered_at
  union all select 18, 'delivery timeline: no delivered event on cancelled orders', count(*)
    from public.orders o join dt on dt.order_id = o.id where o.status = 'cancelled' and dt.n_delivered > 0
  union all select 19, 'riders: assigned rider belongs to the order''s store', count(*)
    from public.orders o join public.riders r on r.id = o.rider_id where r.store_id <> o.store_id
  union all select 20, 'riders: delivery events use the order''s rider', count(*)
    from public.delivery_events d join public.orders o on o.id = d.order_id
    where d.rider_id is not null and d.rider_id is distinct from o.rider_id
  union all select 21, 'riders: only active riders were assigned', count(*)
    from public.orders o join public.riders r on r.id = o.rider_id where r.status <> 'active'
  union all select 22, 'orders: only at live stores', count(*)
    from public.orders o join public.dark_stores s on s.id = o.store_id where s.status <> 'live'
  union all select 23, 'orders: SLA deadline = placed_at + store SLA minutes', count(*)
    from public.orders o join public.dark_stores s on s.id = o.store_id
    where o.sla_deadline_at <> o.placed_at + make_interval(mins => s.sla_minutes)
  union all select 24, 'labels: order numbers are SYN-NNNNNN (seed) or SIM-NNNNNN (simulator)', count(*)
    from public.orders where order_number !~ '^(SYN|SIM)-[0-9]{6}$'
  union all select 25, 'labels: products marked synthetic (SKU SYN-*, brand "(synthetic)")', count(*)
    from public.products where sku !~ '^SYN-' or brand is null or brand not like '%(synthetic)'
  union all select 26, 'labels: dark stores marked "(synthetic)"', count(*)
    from public.dark_stores where name not like '%(synthetic)'
  union all select 27, 'labels: riders marked "(synthetic)"', count(*)
    from public.riders where full_name not like '%(synthetic)'
) checks
order by check_no;
