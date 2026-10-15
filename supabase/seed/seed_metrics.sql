-- =============================================================================
-- QuickOps IQ · Synthetic dataset summary metrics (READ-ONLY)
-- =============================================================================
-- Run each query separately in the Supabase SQL Editor to sanity-check that
-- the synthetic data looks realistic. Nothing here modifies data.
-- Money is stored in paise; divide by 100 for rupees.
-- =============================================================================

-- M1. Headline KPIs (the dashboard's Executive Overview numbers)
select
  count(*)                                                                    as orders,
  count(*) filter (where status = 'delivered')                                as delivered,
  round(100.0 * count(*) filter (where status = 'cancelled') / count(*), 2)   as cancellation_rate_pct,
  round(sum(item_total_paise) filter (where status <> 'cancelled') / 100.0)   as gmv_inr,
  round(avg(item_total_paise) filter (where status <> 'cancelled') / 100.0, 2) as aov_inr,
  round(avg(delivery_seconds) / 60.0, 2)                                       as avg_delivery_min,
  round(100.0 * count(*) filter (where sla_met)
        / nullif(count(*) filter (where status = 'delivered'), 0), 1)         as sla_compliance_pct,
  min(order_date)                                                              as first_day,
  max(order_date)                                                              as last_day
from public.orders;

-- M2. By city
select c.name as city,
       count(*) as orders,
       round(sum(o.item_total_paise) filter (where o.status <> 'cancelled') / 1e7, 2) as gmv_lakh_inr,
       round(avg(o.delivery_seconds) / 60.0, 2) as avg_delivery_min,
       round(100.0 * count(*) filter (where o.sla_met) / nullif(count(*) filter (where o.status = 'delivered'), 0), 1) as sla_pct,
       round(100.0 * count(*) filter (where o.status = 'cancelled') / count(*), 2) as cancel_pct
from public.orders o join public.cities c on c.id = o.city_id
group by c.name order by orders desc;

-- M3. Weekday vs weekend demand (average orders per day)
select case when extract(isodow from order_date) in (6, 7) then 'weekend' else 'weekday' end as day_type,
       round(count(*)::numeric / count(distinct order_date), 1) as avg_orders_per_day
from public.orders group by 1;

-- M4. Hour of day (IST): volume and SLA compliance, showing the peak-hour dip
select extract(hour from placed_at at time zone 'Asia/Kolkata')::int as hour_ist,
       count(*) as orders,
       round(100.0 * count(*) filter (where sla_met) / nullif(count(*) filter (where status = 'delivered'), 0), 1) as sla_pct
from public.orders group by 1 order by 1;

-- M5. Cancellations by reason
select cancellation_reason, count(*) as orders
from public.orders where status = 'cancelled' group by 1 order by 2 desc;

-- M6. Refunds by reason and status
select reason, status, count(*) as refunds, round(sum(amount_paise) / 100.0) as amount_inr
from public.refunds group by 1, 2 order by 1, 2;

-- M7. Stock health: stockout events and short-picked lines by category
select p.category,
       count(*) filter (where e.quantity_after = 0) as stockout_events,
       (select count(*) from public.order_items i join public.products p2 on p2.id = i.product_id
         where p2.category = p.category and i.quantity_fulfilled < i.quantity) as short_picked_lines
from public.inventory_events e join public.products p on p.id = e.product_id
group by p.category order by stockout_events desc;

-- M8. Current stock: items at zero or below reorder level per store
select s.code, s.name,
       count(*) filter (where i.quantity_on_hand = 0) as out_of_stock,
       count(*) filter (where i.quantity_on_hand > 0 and i.quantity_on_hand <= i.reorder_level) as below_reorder
from public.inventory i join public.dark_stores s on s.id = i.store_id
group by s.code, s.name order by s.code;

-- M9. Row counts per table
select 'cities' as table_name, count(*) from public.cities union all
select 'dark_stores', count(*) from public.dark_stores union all
select 'products', count(*) from public.products union all
select 'inventory', count(*) from public.inventory union all
select 'riders', count(*) from public.riders union all
select 'orders', count(*) from public.orders union all
select 'order_items', count(*) from public.order_items union all
select 'inventory_events', count(*) from public.inventory_events union all
select 'order_status_events', count(*) from public.order_status_events union all
select 'delivery_events', count(*) from public.delivery_events union all
select 'refunds', count(*) from public.refunds;
