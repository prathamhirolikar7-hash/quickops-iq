-- =============================================================================
-- QuickOps IQ · Migration 003 · Analytics functions (server-side aggregation)
-- =============================================================================
-- Builds on 001 (schema) and 002 (auth allowlist + RLS). Changes neither.
--
-- Security model
--   * Every analytics function is SECURITY INVOKER: it runs as the caller, so
--     the 002 RLS policies still filter every table it reads. No function
--     here can see more than the caller could see with a direct SELECT.
--   * Each function first calls private.require_dashboard_access(), which
--     raises 42501 for signed-in users who are not approved, so the
--     dashboard can tell "not approved" apart from "no data". (Without it, RLS
--     would silently return zeros.)
--   * EXECUTE: authenticated only. anon and PUBLIC get nothing. postgres and
--     service_role (server-side, never in React) already bypass RLS and are
--     allowed so the SQL Editor can run checks.
--   * search_path = '' and fully qualified names everywhere.
--
-- Performance note: plan_cache_mode = force_custom_plan
--   PL/pgSQL caches plans per session and may switch to a generic plan after
--   5 calls. For date-range parameters the generic plan estimates ~1 order and
--   picks nested loops (measured: 40 ms -> 15 s on 20k orders). PostgREST reuses
--   pooled sessions, so every analytics function is pinned to custom plans;
--   re-planning costs ~1-2 ms per call.
--
-- Reporting conventions (see docs/kpi-dictionary.md)
--   * Dates are IST business dates (orders.order_date). Ranges are inclusive:
--     p_start_date .. p_end_date. Max range 401 days.
--   * Previous period = the same number of days immediately before the start.
--   * Money is returned in integer paise (bigint); the frontend formats INR.
--   * Rates are percentages 0-100 rounded to 2 dp; NULL when the denominator
--     is zero (shown as "—", never as a misleading 0%).
--   * Filters: p_city_id / p_store_id, NULL = all.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Indexes for the analytics access paths
-- -----------------------------------------------------------------------------
-- Covering index: KPI/daily/city/store aggregates over a date range can be
-- answered from the index without touching the heap.
create index if not exists orders_order_date_kpi_idx on public.orders (order_date)
  include (status, store_id, city_id, item_total_paise, discount_paise, delivery_seconds, sla_met);
-- Historical stockouts across all stores within a time window
create index if not exists inventory_events_stockout_time_idx
  on public.inventory_events (occurred_at) where quantity_after = 0;
-- Short-picked order lines (lost sales from stockouts)
create index if not exists order_items_short_picked_idx
  on public.order_items (order_id) where quantity_fulfilled < quantity;

-- -----------------------------------------------------------------------------
-- 2. Private helpers
-- -----------------------------------------------------------------------------
create or replace function private.require_dashboard_access()
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  -- Trusted server-side roles already bypass RLS; nothing further to check.
  if current_user in ('postgres', 'service_role') then
    return;
  end if;
  if not coalesce(private.is_dashboard_member(), false) then
    raise exception 'QuickOps IQ dashboard access required'
      using errcode = '42501',
            hint = 'Your account is signed in but not approved for dashboard access.';
  end if;
end;
$$;

create or replace function private.assert_valid_period(p_start date, p_end date)
returns void
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if p_start is null or p_end is null then
    raise exception 'start and end dates are required' using errcode = '22023';
  end if;
  if p_end < p_start then
    raise exception 'end date % is before start date %', p_end, p_start using errcode = '22023';
  end if;
  if p_end - p_start > 400 then
    raise exception 'date range is limited to 401 days' using errcode = '22023';
  end if;
end;
$$;

revoke all on function private.require_dashboard_access()            from public, anon;
revoke all on function private.assert_valid_period(date, date)        from public, anon;
grant execute on function private.require_dashboard_access()          to authenticated;
grant execute on function private.assert_valid_period(date, date)     to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Executive Overview KPIs (current + previous period, one row)
-- -----------------------------------------------------------------------------
create or replace function public.analytics_overview(
  p_start_date date,
  p_end_date   date,
  p_city_id    uuid default null,
  p_store_id   uuid default null
)
returns table (
  period_start date, period_end date, previous_start date, previous_end date, is_partial_period boolean,
  total_orders bigint, delivered_orders bigint, cancelled_orders bigint, open_orders bigint,
  gmv_paise bigint, discount_paise bigint, refund_paise bigint, net_sales_paise bigint, aov_paise numeric,
  cancellation_rate_pct numeric, on_time_rate_pct numeric,
  avg_delivery_minutes numeric, p90_delivery_minutes numeric, active_dark_stores bigint,
  prev_total_orders bigint, prev_delivered_orders bigint, prev_cancelled_orders bigint,
  prev_gmv_paise bigint, prev_net_sales_paise bigint, prev_aov_paise numeric,
  prev_cancellation_rate_pct numeric, prev_on_time_rate_pct numeric,
  prev_avg_delivery_minutes numeric, prev_active_dark_stores bigint
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
declare
  v_days       int := p_end_date - p_start_date + 1;
  v_prev_start date;
  v_prev_end   date;
begin
  perform private.require_dashboard_access();
  perform private.assert_valid_period(p_start_date, p_end_date);
  v_prev_end   := p_start_date - 1;
  v_prev_start := p_start_date - v_days;

  return query
  with scoped as (
    select o.id, o.store_id, o.status, o.item_total_paise, o.discount_paise,
           o.delivery_seconds, o.sla_met, (o.order_date >= p_start_date) as cur
    from public.orders o
    where o.order_date between v_prev_start and p_end_date
      and (p_city_id  is null or o.city_id  = p_city_id)
      and (p_store_id is null or o.store_id = p_store_id)
  ),
  refunded as (            -- one row per order: no double counting
    select r.order_id, sum(r.amount_paise) as amount
    from public.refunds r
    join scoped s on s.id = r.order_id
    where r.status <> 'failed'
    group by r.order_id
  ),
  x as (
    select s.*, coalesce(rf.amount, 0) as refund
    from scoped s left join refunded rf on rf.order_id = s.id
  )
  select
    p_start_date, p_end_date, v_prev_start, v_prev_end,
    p_end_date >= (now() at time zone 'Asia/Kolkata')::date,
    -- current period
    count(*) filter (where cur),
    count(*) filter (where cur and status = 'delivered'),
    count(*) filter (where cur and status = 'cancelled'),
    count(*) filter (where cur and status not in ('delivered', 'cancelled')),
    coalesce(sum(item_total_paise) filter (where cur and status <> 'cancelled'), 0)::bigint,
    coalesce(sum(discount_paise)   filter (where cur and status <> 'cancelled'), 0)::bigint,
    coalesce(sum(refund)           filter (where cur and status <> 'cancelled'), 0)::bigint,
    coalesce(sum(item_total_paise - discount_paise - refund) filter (where cur and status <> 'cancelled'), 0)::bigint,
    round(sum(item_total_paise) filter (where cur and status <> 'cancelled')::numeric
          / nullif(count(*) filter (where cur and status <> 'cancelled'), 0), 2),
    round(100.0 * count(*) filter (where cur and status = 'cancelled')
          / nullif(count(*) filter (where cur and status in ('delivered', 'cancelled')), 0), 2),
    round(100.0 * count(*) filter (where cur and status = 'delivered' and sla_met)
          / nullif(count(*) filter (where cur and status = 'delivered'), 0), 2),
    round(avg(delivery_seconds) filter (where cur and status = 'delivered') / 60.0, 2),
    round((percentile_cont(0.9) within group (order by delivery_seconds)
           filter (where cur and status = 'delivered'))::numeric / 60, 2),
    count(distinct store_id) filter (where cur),
    -- previous period
    count(*) filter (where not cur),
    count(*) filter (where not cur and status = 'delivered'),
    count(*) filter (where not cur and status = 'cancelled'),
    coalesce(sum(item_total_paise) filter (where not cur and status <> 'cancelled'), 0)::bigint,
    coalesce(sum(item_total_paise - discount_paise - refund) filter (where not cur and status <> 'cancelled'), 0)::bigint,
    round(sum(item_total_paise) filter (where not cur and status <> 'cancelled')::numeric
          / nullif(count(*) filter (where not cur and status <> 'cancelled'), 0), 2),
    round(100.0 * count(*) filter (where not cur and status = 'cancelled')
          / nullif(count(*) filter (where not cur and status in ('delivered', 'cancelled')), 0), 2),
    round(100.0 * count(*) filter (where not cur and status = 'delivered' and sla_met)
          / nullif(count(*) filter (where not cur and status = 'delivered'), 0), 2),
    round(avg(delivery_seconds) filter (where not cur and status = 'delivered') / 60.0, 2),
    count(distinct store_id) filter (where not cur)
  from x;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Daily analytics with aligned previous-period values (zero-filled)
-- -----------------------------------------------------------------------------
create or replace function public.analytics_daily(
  p_start_date date,
  p_end_date   date,
  p_city_id    uuid default null,
  p_store_id   uuid default null
)
returns table (
  report_date date, previous_date date, is_partial_day boolean,
  orders bigint, delivered_orders bigint, cancelled_orders bigint,
  gmv_paise bigint, net_sales_paise bigint, aov_paise numeric,
  on_time_rate_pct numeric, avg_delivery_minutes numeric,
  prev_orders bigint, prev_gmv_paise bigint, prev_net_sales_paise bigint,
  prev_on_time_rate_pct numeric, prev_avg_delivery_minutes numeric
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
declare
  v_days  int := p_end_date - p_start_date + 1;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  perform private.require_dashboard_access();
  perform private.assert_valid_period(p_start_date, p_end_date);

  return query
  with days as (
    select g::date as day, g::date - v_days as prev_day
    from generate_series(p_start_date::timestamp, p_end_date::timestamp, interval '1 day') g
  ),
  scoped as (
    select o.id, o.order_date, o.status, o.item_total_paise, o.discount_paise, o.delivery_seconds, o.sla_met
    from public.orders o
    where o.order_date between p_start_date - v_days and p_end_date
      and (p_city_id  is null or o.city_id  = p_city_id)
      and (p_store_id is null or o.store_id = p_store_id)
  ),
  refunded as (
    select r.order_id, sum(r.amount_paise) as amount
    from public.refunds r join scoped s on s.id = r.order_id
    where r.status <> 'failed'
    group by r.order_id
  ),
  per_day as (
    select s.order_date,
           count(*) as n,
           count(*) filter (where s.status = 'delivered') as n_delivered,
           count(*) filter (where s.status = 'cancelled') as n_cancelled,
           count(*) filter (where s.status <> 'cancelled') as n_valid,
           coalesce(sum(s.item_total_paise) filter (where s.status <> 'cancelled'), 0) as gmv,
           coalesce(sum(s.item_total_paise - s.discount_paise - coalesce(rf.amount, 0))
                    filter (where s.status <> 'cancelled'), 0) as net,
           count(*) filter (where s.status = 'delivered' and s.sla_met) as n_on_time,
           avg(s.delivery_seconds) filter (where s.status = 'delivered') as avg_sec
    from scoped s left join refunded rf on rf.order_id = s.id
    group by s.order_date
  )
  select d.day, d.prev_day, d.day >= v_today,
         coalesce(c.n, 0), coalesce(c.n_delivered, 0), coalesce(c.n_cancelled, 0),
         coalesce(c.gmv, 0)::bigint, coalesce(c.net, 0)::bigint,
         round(c.gmv::numeric / nullif(c.n_valid, 0), 2),
         round(100.0 * c.n_on_time / nullif(c.n_delivered, 0), 2),
         round(c.avg_sec / 60.0, 2),
         coalesce(p.n, 0), coalesce(p.gmv, 0)::bigint, coalesce(p.net, 0)::bigint,
         round(100.0 * p.n_on_time / nullif(p.n_delivered, 0), 2),
         round(p.avg_sec / 60.0, 2)
  from days d
  left join per_day c on c.order_date = d.day
  left join per_day p on p.order_date = d.prev_day
  order by d.day;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Hour-of-day demand and delays (IST, all 24 hours, zero-filled)
-- -----------------------------------------------------------------------------
create or replace function public.analytics_hourly(
  p_start_date date,
  p_end_date   date,
  p_city_id    uuid default null,
  p_store_id   uuid default null
)
returns table (
  hour_ist int, orders bigint, avg_orders_per_day numeric, delivered_orders bigint,
  late_orders bigint, on_time_rate_pct numeric, avg_delivery_minutes numeric
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
declare
  v_days int := p_end_date - p_start_date + 1;
begin
  perform private.require_dashboard_access();
  perform private.assert_valid_period(p_start_date, p_end_date);

  return query
  with x as (
    select extract(hour from o.placed_at at time zone 'Asia/Kolkata')::int as h,
           o.status, o.sla_met, o.delivery_seconds
    from public.orders o
    where o.order_date between p_start_date and p_end_date
      and (p_city_id  is null or o.city_id  = p_city_id)
      and (p_store_id is null or o.store_id = p_store_id)
  )
  select hrs.h,
         count(x.h),
         round(count(x.h)::numeric / v_days, 2),
         count(*) filter (where x.status = 'delivered'),
         count(*) filter (where x.status = 'delivered' and not x.sla_met),
         round(100.0 * count(*) filter (where x.status = 'delivered' and x.sla_met)
               / nullif(count(*) filter (where x.status = 'delivered'), 0), 2),
         round(avg(x.delivery_seconds) filter (where x.status = 'delivered') / 60.0, 2)
  from generate_series(0, 23) as hrs(h)
  left join x on x.h = hrs.h
  group by hrs.h
  order by hrs.h;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. City performance (every city in scope, zero-filled)
-- -----------------------------------------------------------------------------
create or replace function public.analytics_city_performance(
  p_start_date date,
  p_end_date   date,
  p_city_id    uuid default null,
  p_store_id   uuid default null
)
returns table (
  city_id uuid, city_code text, city_name text, active_dark_stores bigint,
  orders bigint, delivered_orders bigint, cancelled_orders bigint,
  gmv_paise bigint, net_sales_paise bigint, aov_paise numeric, gmv_share_pct numeric,
  cancellation_rate_pct numeric, on_time_rate_pct numeric, avg_delivery_minutes numeric
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  perform private.require_dashboard_access();
  perform private.assert_valid_period(p_start_date, p_end_date);

  return query
  with scoped as (
    select o.id, o.city_id, o.store_id, o.status, o.item_total_paise, o.discount_paise, o.delivery_seconds, o.sla_met
    from public.orders o
    where o.order_date between p_start_date and p_end_date
      and (p_city_id  is null or o.city_id  = p_city_id)
      and (p_store_id is null or o.store_id = p_store_id)
  ),
  refunded as (
    select r.order_id, sum(r.amount_paise) as amount
    from public.refunds r join scoped s on s.id = r.order_id
    where r.status <> 'failed'
    group by r.order_id
  ),
  per_city as (
    select s.city_id,
           count(distinct s.store_id) as stores,
           count(*) as n,
           count(*) filter (where s.status = 'delivered') as n_delivered,
           count(*) filter (where s.status = 'cancelled') as n_cancelled,
           count(*) filter (where s.status <> 'cancelled') as n_valid,
           coalesce(sum(s.item_total_paise) filter (where s.status <> 'cancelled'), 0) as gmv,
           coalesce(sum(s.item_total_paise - s.discount_paise - coalesce(rf.amount, 0))
                    filter (where s.status <> 'cancelled'), 0) as net,
           count(*) filter (where s.status = 'delivered' and s.sla_met) as n_on_time,
           avg(s.delivery_seconds) filter (where s.status = 'delivered') as avg_sec
    from scoped s left join refunded rf on rf.order_id = s.id
    group by s.city_id
  )
  select c.id, c.code, c.name,
         coalesce(pc.stores, 0), coalesce(pc.n, 0), coalesce(pc.n_delivered, 0), coalesce(pc.n_cancelled, 0),
         coalesce(pc.gmv, 0)::bigint, coalesce(pc.net, 0)::bigint,
         round(pc.gmv::numeric / nullif(pc.n_valid, 0), 2),
         round(100.0 * coalesce(pc.gmv, 0) / nullif(sum(coalesce(pc.gmv, 0)) over (), 0), 2),
         round(100.0 * pc.n_cancelled / nullif(pc.n_delivered + pc.n_cancelled, 0), 2),
         round(100.0 * pc.n_on_time / nullif(pc.n_delivered, 0), 2),
         round(pc.avg_sec / 60.0, 2)
  from public.cities c
  left join per_city pc on pc.city_id = c.id
  where (p_city_id is null or c.id = p_city_id)
    and (p_store_id is null or c.id = (select ds.city_id from public.dark_stores ds where ds.id = p_store_id))
  order by coalesce(pc.gmv, 0) desc, c.name;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Dark store performance (every store in scope, zero-filled)
-- -----------------------------------------------------------------------------
create or replace function public.analytics_store_performance(
  p_start_date date,
  p_end_date   date,
  p_city_id    uuid default null,
  p_store_id   uuid default null
)
returns table (
  store_id uuid, store_code text, store_name text, city_name text, store_status text,
  orders bigint, delivered_orders bigint, cancelled_orders bigint,
  gmv_paise bigint, net_sales_paise bigint, aov_paise numeric,
  avg_fulfillment_minutes numeric, avg_delivery_minutes numeric,
  on_time_rate_pct numeric, cancellation_rate_pct numeric, fill_rate_pct numeric, gmv_rank bigint
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  perform private.require_dashboard_access();
  perform private.assert_valid_period(p_start_date, p_end_date);

  return query
  with scoped as (
    select o.id, o.store_id, o.status, o.placed_at, o.item_total_paise, o.discount_paise, o.delivery_seconds, o.sla_met
    from public.orders o
    where o.order_date between p_start_date and p_end_date
      and (p_city_id  is null or o.city_id  = p_city_id)
      and (p_store_id is null or o.store_id = p_store_id)
  ),
  refunded as (
    select r.order_id, sum(r.amount_paise) as amount
    from public.refunds r join scoped s on s.id = r.order_id
    where r.status <> 'failed'
    group by r.order_id
  ),
  packed as (                -- unique (order_id, event_type): at most one row per order
    select d.order_id, d.occurred_at
    from public.delivery_events d join scoped s on s.id = d.order_id
    where d.event_type = 'packing_completed'
  ),
  lines as (                 -- delivered orders only: fill rate of what was promised
    select i.order_id, sum(i.quantity) as qty, sum(i.quantity_fulfilled) as fulfilled
    from public.order_items i join scoped s on s.id = i.order_id
    where s.status = 'delivered'
    group by i.order_id
  ),
  per_store as (
    select s.store_id,
           count(*) as n,
           count(*) filter (where s.status = 'delivered') as n_delivered,
           count(*) filter (where s.status = 'cancelled') as n_cancelled,
           count(*) filter (where s.status <> 'cancelled') as n_valid,
           coalesce(sum(s.item_total_paise) filter (where s.status <> 'cancelled'), 0) as gmv,
           coalesce(sum(s.item_total_paise - s.discount_paise - coalesce(rf.amount, 0))
                    filter (where s.status <> 'cancelled'), 0) as net,
           avg(extract(epoch from (pk.occurred_at - s.placed_at))) filter (where s.status = 'delivered') as fulfil_sec,
           count(*) filter (where s.status = 'delivered' and s.sla_met) as n_on_time,
           avg(s.delivery_seconds) filter (where s.status = 'delivered') as avg_sec,
           sum(l.qty) as qty,
           sum(l.fulfilled) as fulfilled
    from scoped s
    left join refunded rf on rf.order_id = s.id
    left join packed pk   on pk.order_id = s.id
    left join lines l     on l.order_id = s.id
    group by s.store_id
  )
  select ds.id, ds.code, ds.name, c.name, ds.status,
         coalesce(ps.n, 0), coalesce(ps.n_delivered, 0), coalesce(ps.n_cancelled, 0),
         coalesce(ps.gmv, 0)::bigint, coalesce(ps.net, 0)::bigint,
         round(ps.gmv::numeric / nullif(ps.n_valid, 0), 2),
         round(ps.fulfil_sec / 60.0, 2),
         round(ps.avg_sec / 60.0, 2),
         round(100.0 * ps.n_on_time / nullif(ps.n_delivered, 0), 2),
         round(100.0 * ps.n_cancelled / nullif(ps.n_delivered + ps.n_cancelled, 0), 2),
         round(100.0 * ps.fulfilled / nullif(ps.qty, 0), 2),
         rank() over (order by coalesce(ps.gmv, 0) desc)
  from public.dark_stores ds
  join public.cities c on c.id = ds.city_id
  left join per_store ps on ps.store_id = ds.id
  where (p_city_id is null or ds.city_id = p_city_id)
    and (p_store_id is null or ds.id = p_store_id)
  order by 17, ds.code;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Delivery delay analysis: stage durations grouped by
--    'overall' | 'hour' | 'weekday' | 'city' | 'store'
-- -----------------------------------------------------------------------------
-- Population: delivered orders. Stages (minutes):
--   queue     placed            -> picking_started
--   picking   picking_started   -> picking_completed
--   packing   picking_completed -> packing_completed
--   dispatch  packing_completed -> dispatched       (waiting for a rider)
--   travel    dispatched        -> arrived_at_customer
--   handover  arrived           -> delivered
-- The six stages add up to the total delivery time. Groups without delivered
-- orders are omitted.
create or replace function public.analytics_delivery_stages(
  p_start_date date,
  p_end_date   date,
  p_city_id    uuid default null,
  p_store_id   uuid default null,
  p_group_by   text default 'overall'
)
returns table (
  group_key text, group_label text, sort_key int,
  delivered_orders bigint, late_orders bigint, late_rate_pct numeric,
  avg_total_minutes numeric, p90_total_minutes numeric,
  avg_queue_minutes numeric, avg_picking_minutes numeric, avg_packing_minutes numeric,
  avg_dispatch_wait_minutes numeric, avg_travel_minutes numeric, avg_handover_minutes numeric,
  avg_minutes_late numeric
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  perform private.require_dashboard_access();
  perform private.assert_valid_period(p_start_date, p_end_date);
  if p_group_by is null or p_group_by not in ('overall', 'hour', 'weekday', 'city', 'store') then
    raise exception 'p_group_by must be one of overall, hour, weekday, city, store' using errcode = '22023';
  end if;

  return query
  with scoped as (
    select o.id, o.store_id, o.city_id, o.placed_at, o.delivered_at, o.sla_deadline_at,
           o.delivery_seconds, o.sla_met
    from public.orders o
    where o.order_date between p_start_date and p_end_date
      and o.status = 'delivered'
      and (p_city_id  is null or o.city_id  = p_city_id)
      and (p_store_id is null or o.store_id = p_store_id)
  ),
  ms as (                    -- one row per order
    select d.order_id,
           max(d.occurred_at) filter (where d.event_type = 'picking_started')     as picking_started,
           max(d.occurred_at) filter (where d.event_type = 'picking_completed')   as picking_completed,
           max(d.occurred_at) filter (where d.event_type = 'packing_completed')   as packing_completed,
           max(d.occurred_at) filter (where d.event_type = 'dispatched')          as dispatched,
           max(d.occurred_at) filter (where d.event_type = 'arrived_at_customer') as arrived
    from public.delivery_events d join scoped s on s.id = d.order_id
    group by d.order_id
  ),
  x as (
    select
      case p_group_by
        when 'overall' then 'all'
        when 'hour'    then lpad(extract(hour from s.placed_at at time zone 'Asia/Kolkata')::int::text, 2, '0')
        when 'weekday' then extract(isodow from s.placed_at at time zone 'Asia/Kolkata')::int::text
        when 'city'    then s.city_id::text
        else s.store_id::text
      end as gkey,
      case p_group_by
        when 'overall' then 'All delivered orders'
        when 'hour'    then lpad(extract(hour from s.placed_at at time zone 'Asia/Kolkata')::int::text, 2, '0') || ':00'
        when 'weekday' then to_char(s.placed_at at time zone 'Asia/Kolkata', 'Dy')
        when 'city'    then c.name
        else ds.code || ' · ' || ds.locality
      end as glabel,
      case p_group_by
        when 'hour'    then extract(hour from s.placed_at at time zone 'Asia/Kolkata')::int
        when 'weekday' then extract(isodow from s.placed_at at time zone 'Asia/Kolkata')::int
        else 0
      end as gsort,
      s.delivery_seconds, s.sla_met,
      extract(epoch from (ms.picking_started   - s.placed_at))         as queue_s,
      extract(epoch from (ms.picking_completed - ms.picking_started))  as picking_s,
      extract(epoch from (ms.packing_completed - ms.picking_completed)) as packing_s,
      extract(epoch from (ms.dispatched        - ms.packing_completed)) as wait_s,
      extract(epoch from (ms.arrived           - ms.dispatched))        as travel_s,
      extract(epoch from (s.delivered_at       - ms.arrived))           as handover_s,
      extract(epoch from (s.delivered_at       - s.sla_deadline_at))    as late_s
    from scoped s
    join ms on ms.order_id = s.id
    join public.dark_stores ds on ds.id = s.store_id
    join public.cities c on c.id = s.city_id
  )
  select x.gkey, min(x.glabel), min(x.gsort),
         count(*),
         count(*) filter (where not x.sla_met),
         round(100.0 * count(*) filter (where not x.sla_met) / nullif(count(*), 0), 2),
         round(avg(x.delivery_seconds) / 60.0, 2),
         round((percentile_cont(0.9) within group (order by x.delivery_seconds))::numeric / 60, 2),
         round(avg(x.queue_s) / 60, 2),
         round(avg(x.picking_s) / 60, 2),
         round(avg(x.packing_s) / 60, 2),
         round(avg(x.wait_s) / 60, 2),
         round(avg(x.travel_s) / 60, 2),
         round(avg(x.handover_s) / 60, 2),
         round(avg(x.late_s) filter (where not x.sla_met) / 60, 2)
  from x
  group by x.gkey
  order by 3, 4 desc, 2;
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Delivery-time distribution (fixed buckets, zero-filled)
-- -----------------------------------------------------------------------------
create or replace function public.analytics_delivery_distribution(
  p_start_date date,
  p_end_date   date,
  p_city_id    uuid default null,
  p_store_id   uuid default null
)
returns table (
  bucket_order int, bucket_label text, min_minutes int, max_minutes int,
  within_10_min boolean, orders bigint, share_pct numeric
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  perform private.require_dashboard_access();
  perform private.assert_valid_period(p_start_date, p_end_date);

  return query
  with buckets(b_order, b_label, b_min, b_max) as (
    values (1, '<6', 0, 6), (2, '6–8', 6, 8), (3, '8–10', 8, 10), (4, '10–12', 10, 12),
           (5, '12–15', 12, 15), (6, '15–20', 15, 20), (7, '20+', 20, null)
  ),
  x as (
    select o.delivery_seconds / 60.0 as mins
    from public.orders o
    where o.order_date between p_start_date and p_end_date
      and o.status = 'delivered'
      and (p_city_id  is null or o.city_id  = p_city_id)
      and (p_store_id is null or o.store_id = p_store_id)
  ),
  counted as (
    select b.b_order, b.b_label, b.b_min, b.b_max, count(x.mins) as n
    from buckets b
    left join x on x.mins >= b.b_min and (b.b_max is null or x.mins < b.b_max)
    group by b.b_order, b.b_label, b.b_min, b.b_max
  )
  select b_order, b_label, b_min, b_max, (b_max is not null and b_max <= 10), n,
         round(100.0 * n / nullif(sum(n) over (), 0), 2)
  from counted
  order by b_order;
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Inventory: current availability by category or store
-- -----------------------------------------------------------------------------
create or replace function public.analytics_inventory_status(
  p_city_id  uuid default null,
  p_store_id uuid default null,
  p_group_by text default 'category'
)
returns table (
  group_key text, group_label text, skus_tracked bigint, in_stock_skus bigint,
  low_stock_skus bigint, out_of_stock_skus bigint, availability_pct numeric, units_on_hand bigint
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  perform private.require_dashboard_access();
  if p_group_by is null or p_group_by not in ('category', 'store') then
    raise exception 'p_group_by must be category or store' using errcode = '22023';
  end if;

  return query
  select case when p_group_by = 'category' then p.category else ds.id::text end,
         min(case when p_group_by = 'category' then p.category else ds.code || ' · ' || ds.locality end),
         count(*),
         count(*) filter (where i.quantity_on_hand > 0),
         count(*) filter (where i.quantity_on_hand > 0 and i.quantity_on_hand <= i.reorder_level),
         count(*) filter (where i.quantity_on_hand = 0),
         round(100.0 * count(*) filter (where i.quantity_on_hand > 0) / nullif(count(*), 0), 2),
         coalesce(sum(i.quantity_on_hand), 0)::bigint
  from public.inventory i
  join public.products p     on p.id = i.product_id
  join public.dark_stores ds on ds.id = i.store_id
  where (p_city_id is null or ds.city_id = p_city_id)
    and (p_store_id is null or ds.id = p_store_id)
  group by 1
  order by 7 asc nulls last, 2;
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. Historical stockouts and lost sales by category (zero-filled)
-- -----------------------------------------------------------------------------
-- stockout_events: ledger movements that left a SKU at zero (IST date range)
-- short-picked lines: order lines picked short in orders that reached picking
create or replace function public.analytics_stockouts(
  p_start_date date,
  p_end_date   date,
  p_city_id    uuid default null,
  p_store_id   uuid default null
)
returns table (
  category text, stockout_events bigint, skus_affected bigint, stores_affected bigint,
  short_picked_lines bigint, short_units bigint, lost_sales_paise bigint
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
declare
  v_from timestamptz := p_start_date::timestamp at time zone 'Asia/Kolkata';
  v_to   timestamptz := (p_end_date + 1)::timestamp at time zone 'Asia/Kolkata';
begin
  perform private.require_dashboard_access();
  perform private.assert_valid_period(p_start_date, p_end_date);

  return query
  with stores as (
    select ds.id from public.dark_stores ds
    where (p_city_id is null or ds.city_id = p_city_id)
      and (p_store_id is null or ds.id = p_store_id)
  ),
  ev as (
    select p.category, count(*) as n,
           count(distinct (e.store_id, e.product_id)) as skus,
           count(distinct e.store_id) as n_stores
    from public.inventory_events e
    join stores st on st.id = e.store_id
    join public.products p on p.id = e.product_id
    where e.quantity_after = 0 and e.occurred_at >= v_from and e.occurred_at < v_to
    group by p.category
  ),
  short as (
    select p.category, count(*) as n_lines,
           sum(i.quantity - i.quantity_fulfilled) as units,
           sum((i.quantity - i.quantity_fulfilled) * i.unit_price_paise) as lost
    from public.order_items i
    join public.orders o   on o.id = i.order_id
    join stores st         on st.id = o.store_id
    join public.products p on p.id = i.product_id
    where i.quantity_fulfilled < i.quantity
      and o.order_date between p_start_date and p_end_date
      and exists (select 1 from public.delivery_events d
                  where d.order_id = o.id and d.event_type = 'picking_completed')
    group by p.category
  ),
  cats as (select distinct pr.category from public.products pr)
  select c.category, coalesce(ev.n, 0), coalesce(ev.skus, 0), coalesce(ev.n_stores, 0),
         coalesce(short.n_lines, 0), coalesce(short.units, 0)::bigint, coalesce(short.lost, 0)::bigint
  from cats c
  left join ev    on ev.category = c.category
  left join short on short.category = c.category
  order by 2 desc, 1;
end;
$$;

-- -----------------------------------------------------------------------------
-- 12. Orders explorer: filter, search, sort, paginate (server-side)
-- -----------------------------------------------------------------------------
-- p_sort_by: placed_at | order_number | total | delivery_time | status | store
-- p_sort_dir: asc | desc. p_limit is clamped to 1..100. Every row carries
-- total_count (rows matching the filters) for pagination; an empty result
-- means total_count = 0. Ties are broken by order id, so pages never overlap.
create or replace function public.analytics_orders_page(
  p_start_date date,
  p_end_date   date,
  p_city_id    uuid    default null,
  p_store_id   uuid    default null,
  p_statuses   text[]  default null,
  p_search     text    default null,
  p_sort_by    text    default 'placed_at',
  p_sort_dir   text    default 'desc',
  p_limit      int     default 25,
  p_offset     int     default 0
)
returns table (
  order_id uuid, order_number text, placed_at timestamptz, order_date date, status text,
  city_name text, store_code text, store_name text, rider_name text, payment_method text,
  items_count bigint, item_total_paise bigint, discount_paise bigint, delivery_fee_paise bigint,
  total_paise bigint, delivery_minutes numeric, sla_deadline_at timestamptz,
  delivered_at timestamptz, sla_met boolean, cancellation_reason text,
  total_count bigint, row_number bigint
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
declare
  v_limit  int := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset int := coalesce(p_offset, 0);
  v_asc    boolean;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_like   text;
begin
  perform private.require_dashboard_access();
  perform private.assert_valid_period(p_start_date, p_end_date);
  if v_offset < 0 then
    raise exception 'p_offset must be >= 0' using errcode = '22023';
  end if;
  if p_sort_by is null or p_sort_by not in ('placed_at', 'order_number', 'total', 'delivery_time', 'status', 'store') then
    raise exception 'unsupported p_sort_by: %', p_sort_by using errcode = '22023';
  end if;
  if lower(coalesce(p_sort_dir, '')) not in ('asc', 'desc') then
    raise exception 'p_sort_dir must be asc or desc' using errcode = '22023';
  end if;
  if p_statuses is not null and exists (
       select 1 from unnest(p_statuses) s
       where s is null or s not in ('placed', 'confirmed', 'picking', 'packed', 'out_for_delivery', 'delivered', 'cancelled')) then
    raise exception 'unsupported status in p_statuses' using errcode = '22023';
  end if;
  if length(v_search) > 64 then
    raise exception 'search text is limited to 64 characters' using errcode = '22023';
  end if;
  v_asc := lower(p_sort_dir) = 'asc';
  -- Escape LIKE wildcards so user input is matched literally
  v_like := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return query
  with filtered as (
    select o.id, o.order_number, o.placed_at, o.order_date, o.status, o.rider_id,
           c.name as city_name, ds.code as store_code, ds.name as store_name, o.payment_method,
           o.item_total_paise, o.discount_paise, o.delivery_fee_paise, o.total_paise,
           o.delivery_seconds, o.sla_deadline_at, o.delivered_at, o.sla_met, o.cancellation_reason,
           count(*) over () as total_count,
           row_number() over (order by
             case when p_sort_by = 'placed_at'     and v_asc     then o.placed_at end asc,
             case when p_sort_by = 'placed_at'     and not v_asc then o.placed_at end desc,
             case when p_sort_by = 'order_number'  and v_asc     then o.order_number end asc,
             case when p_sort_by = 'order_number'  and not v_asc then o.order_number end desc,
             case when p_sort_by = 'total'         and v_asc     then o.total_paise end asc,
             case when p_sort_by = 'total'         and not v_asc then o.total_paise end desc,
             case when p_sort_by = 'delivery_time' and v_asc     then o.delivery_seconds end asc nulls last,
             case when p_sort_by = 'delivery_time' and not v_asc then o.delivery_seconds end desc nulls last,
             case when p_sort_by = 'status'        and v_asc     then o.status end asc,
             case when p_sort_by = 'status'        and not v_asc then o.status end desc,
             case when p_sort_by = 'store'         and v_asc     then ds.code end asc,
             case when p_sort_by = 'store'         and not v_asc then ds.code end desc,
             o.placed_at desc,
             o.id) as rn
    from public.orders o
    join public.dark_stores ds on ds.id = o.store_id
    join public.cities c       on c.id = o.city_id
    where o.order_date between p_start_date and p_end_date
      and (p_city_id  is null or o.city_id  = p_city_id)
      and (p_store_id is null or o.store_id = p_store_id)
      and (p_statuses is null or o.status = any (p_statuses))
      and (v_search is null
           or o.order_number ilike v_like escape '\'
           or ds.code        ilike v_like escape '\'
           or ds.name        ilike v_like escape '\'
           or ds.locality    ilike v_like escape '\')
  ),
  page as (
    select * from filtered f
    where f.rn > v_offset
    order by f.rn
    limit v_limit
  )
  select pg.id, pg.order_number, pg.placed_at, pg.order_date, pg.status,
         pg.city_name, pg.store_code, pg.store_name, r.full_name, pg.payment_method,
         (select count(*) from public.order_items i where i.order_id = pg.id),
         pg.item_total_paise, pg.discount_paise, pg.delivery_fee_paise, pg.total_paise,
         round(pg.delivery_seconds / 60.0, 2), pg.sla_deadline_at, pg.delivered_at, pg.sla_met,
         pg.cancellation_reason, pg.total_count, pg.rn
  from page pg
  left join public.riders r on r.id = pg.rider_id
  order by pg.rn;
end;
$$;

-- -----------------------------------------------------------------------------
-- 13. Data freshness (lets the dashboard default to the latest data window)
-- -----------------------------------------------------------------------------
create or replace function public.analytics_data_freshness()
returns table (
  first_order_date date, last_order_date date, last_order_placed_at timestamptz,
  total_orders bigint, today_ist date
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  perform private.require_dashboard_access();
  return query
  select min(o.order_date), max(o.order_date), max(o.placed_at), count(*),
         (now() at time zone 'Asia/Kolkata')::date
  from public.orders o;
end;
$$;

-- -----------------------------------------------------------------------------
-- 14. EXECUTE grants: authenticated only (approved-member check inside)
-- -----------------------------------------------------------------------------
revoke all on function public.analytics_overview(date, date, uuid, uuid)                  from public, anon;
revoke all on function public.analytics_daily(date, date, uuid, uuid)                     from public, anon;
revoke all on function public.analytics_hourly(date, date, uuid, uuid)                    from public, anon;
revoke all on function public.analytics_city_performance(date, date, uuid, uuid)          from public, anon;
revoke all on function public.analytics_store_performance(date, date, uuid, uuid)         from public, anon;
revoke all on function public.analytics_delivery_stages(date, date, uuid, uuid, text)     from public, anon;
revoke all on function public.analytics_delivery_distribution(date, date, uuid, uuid)     from public, anon;
revoke all on function public.analytics_inventory_status(uuid, uuid, text)                from public, anon;
revoke all on function public.analytics_stockouts(date, date, uuid, uuid)                 from public, anon;
revoke all on function public.analytics_orders_page(date, date, uuid, uuid, text[], text, text, text, int, int) from public, anon;
revoke all on function public.analytics_data_freshness()                                  from public, anon;

grant execute on function public.analytics_overview(date, date, uuid, uuid)               to authenticated;
grant execute on function public.analytics_daily(date, date, uuid, uuid)                  to authenticated;
grant execute on function public.analytics_hourly(date, date, uuid, uuid)                 to authenticated;
grant execute on function public.analytics_city_performance(date, date, uuid, uuid)       to authenticated;
grant execute on function public.analytics_store_performance(date, date, uuid, uuid)      to authenticated;
grant execute on function public.analytics_delivery_stages(date, date, uuid, uuid, text)  to authenticated;
grant execute on function public.analytics_delivery_distribution(date, date, uuid, uuid)  to authenticated;
grant execute on function public.analytics_inventory_status(uuid, uuid, text)             to authenticated;
grant execute on function public.analytics_stockouts(date, date, uuid, uuid)              to authenticated;
grant execute on function public.analytics_orders_page(date, date, uuid, uuid, text[], text, text, text, int, int) to authenticated;
grant execute on function public.analytics_data_freshness()                               to authenticated;

commit;
