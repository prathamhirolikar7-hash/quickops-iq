-- =============================================================================
-- QuickOps IQ · Tests for migration 003 (analytics functions)
-- =============================================================================
-- Run in the Supabase SQL Editor AFTER 003 is applied, on the synthetic data.
--   * Compares every function against independent ground-truth SQL.
--   * Calls functions as anon / a pending user / an approved member, using
--     throwaway users created inside a subtransaction that is ALWAYS rolled
--     back. Nothing persists; no tables are created; business data is only read.
--   * Output: one row per check (pass true/false); the last row is a summary.
-- =============================================================================

-- Run one SQL statement as a role + JWT subject; return its single value as text.
create or replace function pg_temp.qa_val(p_role text, p_uid uuid, p_sql text,
                                          out ok boolean, out val text, out err text)
language plpgsql as $$
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
    perform set_config('role', p_role, true);
    execute p_sql into val;
    raise exception using message = '__qa_ok__';
  exception when others then
    if sqlerrm = '__qa_ok__' then
      ok := true; err := null;
    else
      ok := false; val := null; err := sqlstate || ' ' || sqlerrm;
    end if;
  end;
end;
$$;

-- Run a check and return it as a one-element jsonb array.
--   expected 'error 42501' / 'error 22023' -> the call must fail with that SQLSTATE
--   p_tol not null -> numeric comparison within tolerance
create or replace function pg_temp.qa(p_area text, p_test text, p_expected text,
                                      p_role text, p_uid uuid, p_sql text, p_tol numeric default null)
returns jsonb
language plpgsql as $$
declare
  r record;
  v_actual text;
  v_pass boolean;
begin
  select * into r from pg_temp.qa_val(p_role, p_uid, p_sql);
  if p_expected like 'error %' then
    v_pass := not r.ok and r.err like substr(p_expected, 7) || '%';
    v_actual := case when r.ok then 'ok: ' || coalesce(r.val, 'null') else 'error ' || r.err end;
  else
    v_actual := case when r.ok then coalesce(r.val, 'null') else 'error ' || r.err end;
    v_pass := r.ok and case
      when p_tol is null then coalesce(r.val, 'null') = p_expected
      else r.val is not null and p_expected <> 'null' and abs(r.val::numeric - p_expected::numeric) <= p_tol
    end;
  end if;
  return jsonb_build_array(jsonb_build_object('area', p_area, 'test', p_test, 'expected', p_expected,
                                              'actual', left(v_actual, 140), 'pass', coalesce(v_pass, false)));
end;
$$;

create or replace function pg_temp.qa_analytics_tests()
returns table (n int, area text, test text, expected text, actual text, pass boolean)
language plpgsql as $fn$
declare
  M constant uuid := '00000000-0000-4000-8000-00000000b001'; -- approved member (throwaway)
  P constant uuid := '00000000-0000-4000-8000-00000000b002'; -- signed in, not approved
  A constant text := 'authenticated';
  res jsonb := '[]';
  e text;
  r record;
  v_from date; v_to date; w_from date; w_to date; pw_from date; pw_to date;
  x_from constant date := '2020-01-01'; x_to constant date := '2020-01-07'; -- empty window
  v_city uuid; v_city_name text; v_other_city uuid; v_store uuid; v_store_code text; v_planned uuid; v_sample text;
  all_ids text[] := '{}';
  v_off int := 0;
begin
  if current_user <> 'postgres' then
    raise exception 'Run as postgres (Supabase SQL Editor), not %', current_user;
  end if;
  if to_regprocedure('public.analytics_overview(date,date,uuid,uuid)') is null then
    raise exception 'Migration 003_analytics_functions.sql is not installed.';
  end if;

  select min(o.order_date), max(o.order_date) into v_from, v_to from public.orders o;
  if v_from is null then
    raise exception 'No orders found. Load the synthetic dataset first.';
  end if;
  w_to := v_to; w_from := v_to - 6; pw_to := w_from - 1; pw_from := w_from - 7;
  select o.city_id into v_city from public.orders o group by o.city_id order by count(*) desc, o.city_id limit 1;
  select c.name into v_city_name from public.cities c where c.id = v_city;
  select c.id into v_other_city from public.cities c where c.id <> v_city order by c.code limit 1;
  select o.store_id into v_store from public.orders o where o.city_id = v_city
    group by o.store_id order by count(*) desc, o.store_id limit 1;
  select ds.code into v_store_code from public.dark_stores ds where ds.id = v_store;
  select ds.id into v_planned from public.dark_stores ds
    where not exists (select 1 from public.orders o where o.store_id = ds.id) order by ds.code limit 1;
  select o.order_number into v_sample from public.orders o
    where o.order_date between w_from and w_to order by o.placed_at, o.id limit 1;

  begin -- fixture subtransaction, ALWAYS rolled back
    insert into auth.users (id, email, aud, role) values
      (M, 'qa-approved@example.invalid', 'authenticated', 'authenticated'),
      (P, 'qa-pending@example.invalid',  'authenticated', 'authenticated');
    insert into private.dashboard_members (user_id, approved_by) values (M, 'analytics-test');

    ---------------------------------------------------------------- A. reconciliation
    select count(*)::text into e from public.orders where order_date between v_from and v_to;
    res := res || pg_temp.qa('reconciliation', 'overview total_orders = orders in range (full data window)', e, A, M,
      format('select total_orders::text from public.analytics_overview(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('reconciliation', 'sum of daily orders = total', e, A, M,
      format('select sum(orders)::text from public.analytics_daily(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('reconciliation', 'sum of hourly orders = total', e, A, M,
      format('select sum(orders)::text from public.analytics_hourly(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('reconciliation', 'sum of city orders = total', e, A, M,
      format('select sum(orders)::text from public.analytics_city_performance(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('reconciliation', 'sum of store orders = total', e, A, M,
      format('select sum(orders)::text from public.analytics_store_performance(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('reconciliation', 'orders_page total_count = total', e, A, M,
      format('select max(total_count)::text from public.analytics_orders_page(%L, %L, p_limit => 1)', v_from, v_to));
    res := res || pg_temp.qa('reconciliation', 'data_freshness total_orders = all orders', (select count(*)::text from public.orders), A, M,
      'select total_orders::text from public.analytics_data_freshness()');

    select count(*)::text into e from public.orders where order_date between v_from and v_to and status = 'delivered';
    res := res || pg_temp.qa('reconciliation', 'overview delivered_orders = delivered in range', e, A, M,
      format('select delivered_orders::text from public.analytics_overview(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('reconciliation', 'sum of delivery-distribution buckets = delivered', e, A, M,
      format('select sum(orders)::text from public.analytics_delivery_distribution(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('reconciliation', 'sum of delivery stages by store = delivered', e, A, M,
      format('select sum(delivered_orders)::text from public.analytics_delivery_stages(%L, %L, p_group_by => %L)', v_from, v_to, 'store'));
    res := res || pg_temp.qa('reconciliation', 'sum of delivery stages by hour = delivered', e, A, M,
      format('select sum(delivered_orders)::text from public.analytics_delivery_stages(%L, %L, p_group_by => %L)', v_from, v_to, 'hour'));

    ---------------------------------------------------------------- B. GMV / AOV / net sales
    select coalesce(sum(item_total_paise), 0)::text into e
      from public.orders where order_date between v_from and v_to and status <> 'cancelled';
    res := res || pg_temp.qa('gmv_aov', 'GMV = sum(item_total_paise) of non-cancelled orders', e, A, M,
      format('select gmv_paise::text from public.analytics_overview(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('gmv_aov', 'sum of city GMV = GMV (no join double counting)', e, A, M,
      format('select sum(gmv_paise)::text from public.analytics_city_performance(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('gmv_aov', 'sum of store GMV = GMV', e, A, M,
      format('select sum(gmv_paise)::text from public.analytics_store_performance(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('gmv_aov', 'sum of daily GMV = GMV', e, A, M,
      format('select sum(gmv_paise)::text from public.analytics_daily(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('gmv_aov', 'city GMV shares sum to 100%', '100', A, M,
      format('select sum(gmv_share_pct)::text from public.analytics_city_performance(%L, %L)', v_from, v_to), 0.05);

    select round(sum(item_total_paise)::numeric / count(*), 2)::text into e
      from public.orders where order_date between v_from and v_to and status <> 'cancelled';
    res := res || pg_temp.qa('gmv_aov', 'AOV = GMV / non-cancelled orders', e, A, M,
      format('select aov_paise::text from public.analytics_overview(%L, %L)', v_from, v_to));

    select (coalesce(sum(o.item_total_paise - o.discount_paise), 0)
            - coalesce((select sum(r2.amount_paise) from public.refunds r2 join public.orders o2 on o2.id = r2.order_id
                        where r2.status <> 'failed' and o2.status <> 'cancelled'
                          and o2.order_date between v_from and v_to), 0))::text into e
      from public.orders o where o.order_date between v_from and v_to and o.status <> 'cancelled';
    res := res || pg_temp.qa('gmv_aov', 'net sales = GMV - discounts - refunds (non-cancelled)', e, A, M,
      format('select net_sales_paise::text from public.analytics_overview(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('gmv_aov', 'sum of daily net sales = net sales', e, A, M,
      format('select sum(net_sales_paise)::text from public.analytics_daily(%L, %L)', v_from, v_to));

    ---------------------------------------------------------------- C. delivery metrics
    select round(100.0 * count(*) filter (where sla_met) / count(*), 2)::text into e
      from public.orders where order_date between v_from and v_to and status = 'delivered';
    res := res || pg_temp.qa('delivery', 'on-time rate = sla_met / delivered', e, A, M,
      format('select on_time_rate_pct::text from public.analytics_overview(%L, %L)', v_from, v_to));
    select round(avg(delivery_seconds) / 60.0, 2)::text into e
      from public.orders where order_date between v_from and v_to and status = 'delivered';
    res := res || pg_temp.qa('delivery', 'avg delivery minutes = avg(delivery_seconds)/60', e, A, M,
      format('select avg_delivery_minutes::text from public.analytics_overview(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('delivery', 'stage averages sum to the total delivery time', 'true', A, M,
      format($q$select (abs(avg_queue_minutes + avg_picking_minutes + avg_packing_minutes + avg_dispatch_wait_minutes
                          + avg_travel_minutes + avg_handover_minutes - avg_total_minutes) <= 0.05)::text
                from public.analytics_delivery_stages(%L, %L)$q$, v_from, v_to));
    select count(*) filter (where not sla_met)::text into e
      from public.orders where order_date between v_from and v_to and status = 'delivered';
    res := res || pg_temp.qa('delivery', 'late orders = delivered and not sla_met', e, A, M,
      format('select late_orders::text from public.analytics_delivery_stages(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('delivery', 'p90 delivery >= average delivery', 'true', A, M,
      format('select (p90_delivery_minutes >= avg_delivery_minutes)::text from public.analytics_overview(%L, %L)', v_from, v_to));

    ---------------------------------------------------------------- D. cancellation rate
    select round(100.0 * count(*) filter (where status = 'cancelled')
                 / count(*) filter (where status in ('delivered', 'cancelled')), 2)::text into e
      from public.orders where order_date between v_from and v_to;
    res := res || pg_temp.qa('cancellation', 'cancellation rate = cancelled / (delivered + cancelled)', e, A, M,
      format('select cancellation_rate_pct::text from public.analytics_overview(%L, %L)', v_from, v_to));
    select count(*)::text into e from public.orders where order_date between v_from and v_to and status = 'cancelled';
    res := res || pg_temp.qa('cancellation', 'cancelled count via orders_page status filter', e, A, M,
      format('select coalesce(max(total_count), 0)::text from public.analytics_orders_page(%L, %L, p_statuses => %L, p_limit => 1)',
             v_from, v_to, '{cancelled}'));

    ---------------------------------------------------------------- E. city filter
    select count(*)::text into e from public.orders where order_date between v_from and v_to and city_id = v_city;
    res := res || pg_temp.qa('city_filter', 'overview(city) total = orders in that city', e, A, M,
      format('select total_orders::text from public.analytics_overview(%L, %L, %L)', v_from, v_to, v_city));
    select coalesce(sum(item_total_paise), 0)::text into e from public.orders
      where order_date between v_from and v_to and city_id = v_city and status <> 'cancelled';
    res := res || pg_temp.qa('city_filter', 'overview(city) GMV = city GMV', e, A, M,
      format('select gmv_paise::text from public.analytics_overview(%L, %L, %L)', v_from, v_to, v_city));
    res := res || pg_temp.qa('city_filter', 'city_performance(city) returns exactly that city', '1', A, M,
      format('select count(*)::text from public.analytics_city_performance(%L, %L, %L)', v_from, v_to, v_city));
    res := res || pg_temp.qa('city_filter', 'orders_page(city) rows all belong to the city', '0', A, M,
      format('select count(*) filter (where city_name <> %L)::text from public.analytics_orders_page(%L, %L, %L, p_limit => 100)',
             v_city_name, v_from, v_to, v_city));
    select count(*)::text into e from public.dark_stores where city_id = v_city;
    res := res || pg_temp.qa('city_filter', 'store_performance(city) lists every store of the city', e, A, M,
      format('select count(*)::text from public.analytics_store_performance(%L, %L, %L)', v_from, v_to, v_city));

    ---------------------------------------------------------------- F. store filter
    select count(*)::text into e from public.orders where order_date between v_from and v_to and store_id = v_store;
    res := res || pg_temp.qa('store_filter', 'overview(store) total = orders at that store', e, A, M,
      format('select total_orders::text from public.analytics_overview(%L, %L, null, %L)', v_from, v_to, v_store));
    res := res || pg_temp.qa('store_filter', 'store_performance(store) orders match', e, A, M,
      format('select orders::text from public.analytics_store_performance(%L, %L, null, %L)', v_from, v_to, v_store));
    res := res || pg_temp.qa('store_filter', 'orders_page(store) rows all belong to the store', '0', A, M,
      format('select count(*) filter (where store_code <> %L)::text from public.analytics_orders_page(%L, %L, null, %L, p_limit => 100)',
             v_store_code, v_from, v_to, v_store));
    res := res || pg_temp.qa('store_filter', 'store in a different city filter -> zero orders', '0', A, M,
      format('select total_orders::text from public.analytics_overview(%L, %L, %L, %L)', v_from, v_to, v_other_city, v_store));
    if v_planned is not null then
      res := res || pg_temp.qa('store_filter', 'store with no orders -> 0 orders, AOV null', '0|null', A, M,
        format('select orders || ''|'' || coalesce(aov_paise::text, ''null'') from public.analytics_store_performance(%L, %L, null, %L)',
               v_from, v_to, v_planned));
    end if;

    ---------------------------------------------------------------- G. date filter + previous period
    select count(*)::text into e from public.orders where order_date between w_from and w_to;
    res := res || pg_temp.qa('date_filter', 'last 7 days total = orders in those IST dates', e, A, M,
      format('select total_orders::text from public.analytics_overview(%L, %L)', w_from, w_to));
    select count(*)::text into e from public.orders where order_date between pw_from and pw_to;
    res := res || pg_temp.qa('date_filter', 'previous-period total = the 7 days before', e, A, M,
      format('select prev_total_orders::text from public.analytics_overview(%L, %L)', w_from, w_to));
    select coalesce(sum(item_total_paise), 0)::text into e from public.orders
      where order_date between pw_from and pw_to and status <> 'cancelled';
    res := res || pg_temp.qa('date_filter', 'previous-period GMV = GMV of the 7 days before', e, A, M,
      format('select prev_gmv_paise::text from public.analytics_overview(%L, %L)', w_from, w_to));
    res := res || pg_temp.qa('date_filter', 'daily(7-day window) returns 7 rows', '7', A, M,
      format('select count(*)::text from public.analytics_daily(%L, %L)', w_from, w_to));
    select count(*)::text into e from public.orders
      where placed_at >= (v_to::timestamp at time zone 'Asia/Kolkata')
        and placed_at <  ((v_to + 1)::timestamp at time zone 'Asia/Kolkata');
    res := res || pg_temp.qa('date_filter', 'IST day boundary: day count = orders placed 00:00-23:59 IST', e, A, M,
      format('select orders::text from public.analytics_daily(%L, %L)', v_to, v_to));
    res := res || pg_temp.qa('date_filter', 'today (IST) is flagged as a partial period', 'true', A, M,
      format('select is_partial_period::text from public.analytics_overview(%L, %L)',
             (now() at time zone 'Asia/Kolkata')::date, (now() at time zone 'Asia/Kolkata')::date));

    ---------------------------------------------------------------- H. empty result sets
    res := res || pg_temp.qa('empty', 'overview on a window with no data: counts 0, rates NULL', '0|0|null|null|null|null', A, M,
      format($q$select total_orders || '|' || gmv_paise || '|' || coalesce(aov_paise::text, 'null') || '|'
                    || coalesce(on_time_rate_pct::text, 'null') || '|' || coalesce(cancellation_rate_pct::text, 'null') || '|'
                    || coalesce(avg_delivery_minutes::text, 'null')
                from public.analytics_overview(%L, %L)$q$, x_from, x_to));
    res := res || pg_temp.qa('empty', 'daily on empty window: 7 zero-filled rows', '7|0', A, M,
      format('select count(*) || ''|'' || sum(orders) from public.analytics_daily(%L, %L)', x_from, x_to));
    res := res || pg_temp.qa('empty', 'hourly on empty window: 24 zero-filled rows', '24|0', A, M,
      format('select count(*) || ''|'' || sum(orders) from public.analytics_hourly(%L, %L)', x_from, x_to));
    select count(*) || '|0|null' into e from public.cities;
    res := res || pg_temp.qa('empty', 'city_performance on empty window: every city, zero, share NULL', e, A, M,
      format($q$select count(*) || '|' || sum(orders) || '|' || coalesce(max(gmv_share_pct)::text, 'null')
                from public.analytics_city_performance(%L, %L)$q$, x_from, x_to));
    res := res || pg_temp.qa('empty', 'distribution on empty window: 7 buckets, share NULL', '7|0|null', A, M,
      format($q$select count(*) || '|' || sum(orders) || '|' || coalesce(max(share_pct)::text, 'null')
                from public.analytics_delivery_distribution(%L, %L)$q$, x_from, x_to));
    res := res || pg_temp.qa('empty', 'orders_page on empty window: no rows', '0', A, M,
      format('select count(*)::text from public.analytics_orders_page(%L, %L)', x_from, x_to));
    res := res || pg_temp.qa('empty', 'delivery stages on empty window: no groups', '0', A, M,
      format('select count(*)::text from public.analytics_delivery_stages(%L, %L)', x_from, x_to));
    res := res || pg_temp.qa('empty', 'stockouts on empty window: zero events', '0', A, M,
      format('select sum(stockout_events)::text from public.analytics_stockouts(%L, %L)', x_from, x_to));
    res := res || pg_temp.qa('empty', 'previous period before the first order is zero', '0', A, M,
      format('select prev_total_orders::text from public.analytics_overview(%L, %L)', v_from, v_to));

    ---------------------------------------------------------------- I. inventory
    select count(*)::text into e from public.inventory;
    res := res || pg_temp.qa('inventory', 'inventory_status: sum of SKUs tracked = inventory rows (by category)', e, A, M,
      'select sum(skus_tracked)::text from public.analytics_inventory_status()');
    res := res || pg_temp.qa('inventory', 'inventory_status: sum of SKUs tracked = inventory rows (by store)', e, A, M,
      $q$select sum(skus_tracked)::text from public.analytics_inventory_status(p_group_by => 'store')$q$);
    select count(*)::text into e from public.inventory where quantity_on_hand = 0;
    res := res || pg_temp.qa('inventory', 'inventory_status: out-of-stock SKUs = rows at zero', e, A, M,
      'select sum(out_of_stock_skus)::text from public.analytics_inventory_status()');
    select count(*)::text into e from public.inventory_events
      where quantity_after = 0
        and occurred_at >= (v_from::timestamp at time zone 'Asia/Kolkata')
        and occurred_at <  ((v_to + 1)::timestamp at time zone 'Asia/Kolkata');
    res := res || pg_temp.qa('inventory', 'stockouts: events = ledger rows reaching zero (IST window)', e, A, M,
      format('select sum(stockout_events)::text from public.analytics_stockouts(%L, %L)', v_from, v_to));
    select count(*)::text into e from public.order_items i join public.orders o on o.id = i.order_id
      where i.quantity_fulfilled < i.quantity and o.order_date between v_from and v_to
        and exists (select 1 from public.delivery_events d where d.order_id = o.id and d.event_type = 'picking_completed');
    res := res || pg_temp.qa('inventory', 'stockouts: short-picked lines = items picked short', e, A, M,
      format('select sum(short_picked_lines)::text from public.analytics_stockouts(%L, %L)', v_from, v_to));

    ---------------------------------------------------------------- J. unauthorized access
    res := res || pg_temp.qa('security', 'anon cannot call analytics_overview', 'error 42501', 'anon', null,
      format('select total_orders::text from public.analytics_overview(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('security', 'anon cannot call analytics_orders_page', 'error 42501', 'anon', null,
      format('select count(*)::text from public.analytics_orders_page(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('security', 'anon cannot call analytics_inventory_status', 'error 42501', 'anon', null,
      'select count(*)::text from public.analytics_inventory_status()');
    res := res || pg_temp.qa('security', 'anon cannot call analytics_data_freshness', 'error 42501', 'anon', null,
      'select total_orders::text from public.analytics_data_freshness()');
    res := res || pg_temp.qa('security', 'anon cannot call private.require_dashboard_access', 'error 42501', 'anon', null,
      'select private.require_dashboard_access()::text');
    res := res || pg_temp.qa('security', 'pending user: analytics_overview denied', 'error 42501', A, P,
      format('select total_orders::text from public.analytics_overview(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('security', 'pending user: analytics_daily denied', 'error 42501', A, P,
      format('select count(*)::text from public.analytics_daily(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('security', 'pending user: analytics_city_performance denied', 'error 42501', A, P,
      format('select count(*)::text from public.analytics_city_performance(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('security', 'pending user: analytics_orders_page denied', 'error 42501', A, P,
      format('select count(*)::text from public.analytics_orders_page(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('security', 'pending user: analytics_stockouts denied', 'error 42501', A, P,
      format('select count(*)::text from public.analytics_stockouts(%L, %L)', v_from, v_to));
    res := res || pg_temp.qa('security', 'pending user: direct table read still returns 0 rows (002 RLS intact)', '0', A, P,
      'select count(*)::text from public.orders');
    res := res || pg_temp.qa('security', 'approved member: analytics_data_freshness allowed', (select count(*)::text from public.orders), A, M,
      'select total_orders::text from public.analytics_data_freshness()');

    ---------------------------------------------------------------- K. pagination, sorting, search
    select count(*)::text into e from public.orders where order_date between w_from and w_to;
    loop
      select * into r from pg_temp.qa_val(A, M, format(
        'select string_agg(order_id::text, %L order by row_number) from public.analytics_orders_page(%L, %L, p_sort_by => %L, p_sort_dir => %L, p_limit => 100, p_offset => %s)',
        ',', w_from, w_to, 'total', 'desc', v_off));
      exit when not r.ok or r.val is null or v_off > 100000;
      all_ids := all_ids || string_to_array(r.val, ',');
      v_off := v_off + 100;
    end loop;
    res := res || pg_temp.qa('pagination', 'walking all pages (100/page) returns every order', e, 'postgres', null,
      format('select %s::text', coalesce(array_length(all_ids, 1), 0)));
    res := res || pg_temp.qa('pagination', 'no order appears on two pages', e, 'postgres', null,
      format('select count(distinct x)::text from unnest(%L::text[]) x', all_ids));
    res := res || pg_temp.qa('pagination', 'sorted by total desc: page is non-increasing', 'true', A, M,
      format($q$select coalesce(bool_and(total_paise >= nxt), true)::text from (
                  select total_paise, lead(total_paise) over (order by row_number) as nxt
                  from public.analytics_orders_page(%L, %L, p_sort_by => 'total', p_sort_dir => 'desc', p_limit => 100)) s$q$,
             w_from, w_to));
    res := res || pg_temp.qa('pagination', 'sorted by placed_at asc: page is non-decreasing', 'true', A, M,
      format($q$select coalesce(bool_and(placed_at <= nxt), true)::text from (
                  select placed_at, lead(placed_at) over (order by row_number) as nxt
                  from public.analytics_orders_page(%L, %L, p_sort_by => 'placed_at', p_sort_dir => 'asc', p_limit => 100)) s$q$,
             w_from, w_to));
    res := res || pg_temp.qa('pagination', 'limit is clamped to 100', least(100, e::int)::text, A, M,
      format('select count(*)::text from public.analytics_orders_page(%L, %L, p_limit => 1000)', w_from, w_to));
    res := res || pg_temp.qa('pagination', 'offset beyond the last row returns no rows', '0', A, M,
      format('select count(*)::text from public.analytics_orders_page(%L, %L, p_offset => 1000000)', w_from, w_to));
    res := res || pg_temp.qa('pagination', 'search by exact order number finds exactly it', '1|' || v_sample, A, M,
      format('select max(total_count) || ''|'' || max(order_number) from public.analytics_orders_page(%L, %L, p_search => %L)',
             w_from, w_to, v_sample));
    res := res || pg_temp.qa('pagination', 'search is case-insensitive', '1', A, M,
      format('select max(total_count)::text from public.analytics_orders_page(%L, %L, p_search => %L)', w_from, w_to, lower(v_sample)));
    res := res || pg_temp.qa('pagination', 'LIKE wildcards in search are matched literally', '0', A, M,
      format('select count(*)::text from public.analytics_orders_page(%L, %L, p_search => %L)', w_from, w_to, '%'));

    ---------------------------------------------------------------- L. parameter validation
    res := res || pg_temp.qa('validation', 'end date before start date', 'error 22023', A, M,
      format('select total_orders::text from public.analytics_overview(%L, %L)', v_to, v_to - 1));
    res := res || pg_temp.qa('validation', 'range longer than 401 days', 'error 22023', A, M,
      format('select total_orders::text from public.analytics_overview(%L, %L)', v_to - 500, v_to));
    res := res || pg_temp.qa('validation', 'missing dates', 'error 22023', A, M,
      'select total_orders::text from public.analytics_overview(null, null)');
    res := res || pg_temp.qa('validation', 'unsupported sort column', 'error 22023', A, M,
      format('select count(*)::text from public.analytics_orders_page(%L, %L, p_sort_by => %L)', w_from, w_to, 'placed_at; select 1'));
    res := res || pg_temp.qa('validation', 'unsupported sort direction', 'error 22023', A, M,
      format('select count(*)::text from public.analytics_orders_page(%L, %L, p_sort_dir => %L)', w_from, w_to, 'sideways'));
    res := res || pg_temp.qa('validation', 'unsupported status filter', 'error 22023', A, M,
      format('select count(*)::text from public.analytics_orders_page(%L, %L, p_statuses => %L)', w_from, w_to, '{lost}'));
    res := res || pg_temp.qa('validation', 'negative offset', 'error 22023', A, M,
      format('select count(*)::text from public.analytics_orders_page(%L, %L, p_offset => -1)', w_from, w_to));
    res := res || pg_temp.qa('validation', 'unsupported delivery-stage grouping', 'error 22023', A, M,
      format('select count(*)::text from public.analytics_delivery_stages(%L, %L, p_group_by => %L)', w_from, w_to, 'rider'));
    res := res || pg_temp.qa('validation', 'unsupported inventory grouping', 'error 22023', A, M,
      $q$select count(*)::text from public.analytics_inventory_status(p_group_by => 'brand')$q$);

    raise exception using message = '__qa_rollback__';
  exception when others then
    if sqlerrm <> '__qa_rollback__' then
      raise;
    end if;
  end;

  return query
    select (t.ord)::int, t.j ->> 'area', t.j ->> 'test', t.j ->> 'expected', t.j ->> 'actual', (t.j ->> 'pass')::boolean
    from jsonb_array_elements(res) with ordinality as t(j, ord);
end;
$fn$;

with results as materialized (select * from pg_temp.qa_analytics_tests())
select n, area, test, expected, actual, pass from results
union all
select null, 'SUMMARY', format('%s passed, %s failed', count(*) filter (where pass), count(*) filter (where not pass)),
       '', '', bool_and(pass)
from results
order by 1 nulls last;
