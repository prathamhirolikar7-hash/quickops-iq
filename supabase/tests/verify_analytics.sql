-- =============================================================================
-- QuickOps IQ · Read-only verification queries for migration 003
-- =============================================================================
-- Run each query separately in the Supabase SQL Editor (as postgres).
-- Nothing here modifies data. "Expected" notes describe the state after 003.
-- =============================================================================

-- V1. Analytics functions: security mode, settings, who can execute
--     Expected: 11 rows; security_definer = false; settings contain
--     search_path="" and plan_cache_mode=force_custom_plan; anon_exec = false;
--     authenticated_exec = true; volatility = s (stable).
select p.proname as function,
       pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef as security_definer,
       p.provolatile as volatility,
       p.proconfig as settings,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'analytics\_%'
order by 1;

-- V2. No EXECUTE granted to PUBLIC on any analytics function
--     Expected: zero rows.
select p.proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
     aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
where n.nspname = 'public' and p.proname like 'analytics\_%' and a.grantee = 0;

-- V3. Private helpers: invoker, not callable by anon
--     Expected: require_dashboard_access and assert_valid_period with
--     security_definer = false, anon_exec = false, authenticated_exec = true.
--     is_dashboard_member remains the ONLY security-definer function.
select p.proname, p.prosecdef as security_definer,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'private'
order by 1;

-- V4. RLS unchanged by 003
--     Expected: 11 SELECT policies for authenticated; no other policies.
select tablename, policyname, cmd, roles from pg_policies
where schemaname in ('public', 'private') order by tablename;

-- V5. Indexes added by 003
--     Expected: 3 rows.
select indexname, indexdef from pg_indexes
where indexname in ('orders_order_date_kpi_idx', 'inventory_events_stockout_time_idx', 'order_items_short_picked_idx');

-- V6. Smoke test of every function over the full data window (as postgres,
--     which is allowed for SQL Editor checks). Compare with seed_metrics.sql M1.
select * from public.analytics_data_freshness();

select total_orders, delivered_orders, cancelled_orders, gmv_paise / 100.0 as gmv_inr,
       net_sales_paise / 100.0 as net_sales_inr, aov_paise / 100.0 as aov_inr,
       cancellation_rate_pct, on_time_rate_pct, avg_delivery_minutes, p90_delivery_minutes, active_dark_stores
from public.analytics_overview(
  (select min(order_date) from public.orders), (select max(order_date) from public.orders));

-- V7. Last 7 days of data vs the 7 days before (previous-period comparison)
select period_start, period_end, total_orders, prev_total_orders,
       gmv_paise / 100.0 as gmv_inr, prev_gmv_paise / 100.0 as prev_gmv_inr,
       on_time_rate_pct, prev_on_time_rate_pct
from public.analytics_overview(
  (select max(order_date) - 6 from public.orders), (select max(order_date) from public.orders));

-- V8. City and store league tables
select city_name, orders, gmv_paise / 100.0 as gmv_inr, gmv_share_pct, on_time_rate_pct, cancellation_rate_pct, avg_delivery_minutes
from public.analytics_city_performance(
  (select min(order_date) from public.orders), (select max(order_date) from public.orders));

select gmv_rank, store_code, city_name, store_status, orders, gmv_paise / 100.0 as gmv_inr,
       avg_fulfillment_minutes, on_time_rate_pct, fill_rate_pct
from public.analytics_store_performance(
  (select min(order_date) from public.orders), (select max(order_date) from public.orders));

-- V9. Where does delivery time go, by hour?
select group_label, delivered_orders, late_rate_pct, avg_total_minutes, avg_queue_minutes, avg_picking_minutes,
       avg_packing_minutes, avg_dispatch_wait_minutes, avg_travel_minutes, avg_handover_minutes
from public.analytics_delivery_stages(
  (select min(order_date) from public.orders), (select max(order_date) from public.orders), p_group_by => 'hour');

-- V10. Plan check: the KPI scan uses the date index (expect an Index or
--      Index Only Scan on orders_order_date_kpi_idx / orders_order_date_idx for
--      a 7-day window; a sequential scan is normal for the full 90 days).
explain
select count(*), sum(item_total_paise) filter (where status <> 'cancelled')
from public.orders
where order_date between (select max(order_date) - 6 from public.orders) and (select max(order_date) from public.orders);
