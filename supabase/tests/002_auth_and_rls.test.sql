-- =============================================================================
-- QuickOps IQ · Permission tests for migration 002 (auth allowlist + RLS)
-- =============================================================================
-- Safe to run in the hosted Supabase SQL Editor AFTER 002 is applied.
--
-- What this script creates
--   * Two TEMPORARY functions in pg_temp (this session only, invisible to
--     every other connection including the Data API, removed at disconnect).
--   * No tables. Results are returned as rows; nothing is stored.
--
-- Why it cannot change your data
--   * All fixtures (3 throwaway auth users, 1 row per business table, a probe
--     table and view) and all 99 checks run inside a subtransaction that is
--     ALWAYS rolled back by a forced exception at the end.
--   * Each check also runs in its own subtransaction that is ALWAYS rolled
--     back, even when the statement succeeds.
--   * UPDATE/DELETE probes use "WHERE false": PostgreSQL still checks the
--     privilege (the test stays strict), but no row can ever match.
--   * The script refuses to run if migration 002 is not installed.
--   * Only side effect: the 3 fixture inserts into the event tables consume 3
--     identity values. Sequences are never rolled back in PostgreSQL, so you
--     may see a gap in those surrogate ids. Harmless.
--
-- The SQL Editor's "destructive operation" warning is triggered by the words
-- DELETE / TRUNCATE in the probe strings below. Those statements are executed
-- as anon/authenticated, are expected to be DENIED, and are rolled back anyway.
-- =============================================================================

-- Runs one statement as a given role + JWT subject, then rolls it back.
create or replace function pg_temp.qo_run_as(
  p_role text, p_uid uuid, p_sql text,
  out ok boolean, out row_count bigint, out err text
)
language plpgsql
as $$
begin
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', p_role)::text, true);
    perform set_config('role', p_role, true);
    if p_sql ~* '^\s*select' then
      execute p_sql into row_count;
    else
      execute p_sql;
      get diagnostics row_count = row_count;
    end if;
    raise exception using message = '__qo_rollback_probe__';
  exception when others then
    if sqlerrm = '__qo_rollback_probe__' then
      ok := true; err := null;
    else
      ok := false; row_count := null; err := sqlstate || ' ' || sqlerrm;
    end if;
  end;
end;
$$;

-- Builds fixtures, runs all checks, rolls everything back, returns results.
create or replace function pg_temp.qo_rls_tests()
returns table (n int, test text, actor text, expected text, actual text, pass boolean)
language plpgsql
as $fn$
declare
  -- Throwaway identities (never persisted)
  u_approved constant uuid := '00000000-0000-4000-8000-00000000a001';
  u_pending  constant uuid := '00000000-0000-4000-8000-00000000a002';
  u_revoked  constant uuid := '00000000-0000-4000-8000-00000000a003';

  tables constant text[] := array['cities','dark_stores','products','inventory','inventory_events',
                                  'riders','orders','order_items','order_status_events',
                                  'delivery_events','refunds'];
  r record;
  res record;
  act text;
  -- Collected results survive the rollback below
  names text[] := '{}'; actors text[] := '{}'; exps text[] := '{}'; acts text[] := '{}'; passes boolean[] := '{}';
  v_city uuid; v_store uuid; v_prod uuid; v_rider uuid; v_order uuid;
begin
  if to_regprocedure('private.is_dashboard_member()') is null
     or to_regclass('private.dashboard_members') is null then
    raise exception 'Migration 002_auth_and_rls.sql is not installed; refusing to run permission tests.';
  end if;
  if current_user <> 'postgres' then
    raise exception 'Run this script as postgres (Supabase SQL Editor), not as %', current_user;
  end if;

  begin  -- fixture subtransaction, ALWAYS rolled back
    ---------------------------------------------------------------- fixtures
    insert into auth.users (id, email, aud, role) values
      (u_approved, 'rls-approved@example.invalid', 'authenticated', 'authenticated'),
      (u_pending,  'rls-pending@example.invalid',  'authenticated', 'authenticated'),
      (u_revoked,  'rls-revoked@example.invalid',  'authenticated', 'authenticated');
    insert into private.dashboard_members (user_id, approved_by, is_active) values
      (u_approved, 'rls-test', true),
      (u_revoked,  'rls-test', false);

    insert into public.cities (code, name, state) values ('ZZT', 'RLS Test City', 'Test')
      returning id into v_city;
    insert into public.dark_stores (city_id, code, name, locality) values (v_city, 'ZZT-01', 'RLS Test Store', 'Test')
      returning id into v_store;
    insert into public.products (sku, name, category, unit_label, mrp_paise, selling_price_paise)
      values ('RLS-TEST-SKU', 'Test product', 'Test', '1 pc', 1000, 900) returning id into v_prod;
    insert into public.inventory (store_id, product_id, quantity_on_hand) values (v_store, v_prod, 5);
    insert into public.riders (store_id, full_name, employment_type, vehicle_type, joined_on)
      values (v_store, 'RLS Test Rider', 'gig', 'e_bike', current_date) returning id into v_rider;
    insert into public.orders (order_number, store_id, city_id, rider_id, status, payment_method,
                               item_total_paise, placed_at, sla_deadline_at, delivered_at)
      values ('RLS-TEST-1', v_store, v_city, v_rider, 'delivered', 'upi', 900,
              now() - interval '20 min', now() - interval '10 min', now() - interval '12 min')
      returning id into v_order;
    insert into public.order_items (order_id, product_id, quantity, quantity_fulfilled, unit_mrp_paise, unit_price_paise)
      values (v_order, v_prod, 1, 1, 1000, 900);
    insert into public.inventory_events (store_id, product_id, event_type, quantity_change, quantity_after, order_id)
      values (v_store, v_prod, 'sale', -1, 4, v_order);
    insert into public.order_status_events (order_id, from_status, to_status, actor) values (v_order, null, 'placed', 'customer');
    insert into public.delivery_events (order_id, rider_id, event_type) values (v_order, v_rider, 'dispatched');
    insert into public.refunds (order_id, amount_paise, reason) values (v_order, 100, 'other');

    -- Objects created after 002 must NOT be readable by default (rolled back too)
    create table public.zz_rls_probe_table (id int);
    create view public.zz_rls_probe_view as select id from public.orders;

    ---------------------------------------------------------------- checks
    -- expected / actual: 'denied' | 'zero rows' | 'has rows'
    for r in
      with cases(test, actor, uid, sql, expected) as (
        -- 1. Unauthenticated visitor: read denial
        select 'anon read ' || t, 'anon', null::uuid, format('select count(*) from public.%I', t), 'denied'
          from unnest(tables) t
        union all
        -- 2. Unauthenticated visitor: write denial
        select * from (values
          ('anon insert cities',  'anon', null::uuid, $q$insert into public.cities (code, name, state) values ('ZZA','x','x')$q$, 'denied'),
          ('anon update orders',  'anon', null::uuid, $q$update public.orders set payment_method = 'cod' where false$q$, 'denied'),
          ('anon delete refunds', 'anon', null::uuid, $q$delete from public.refunds where false$q$, 'denied'),
          ('anon truncate orders','anon', null::uuid, $q$truncate public.orders cascade$q$, 'denied'),
          ('anon call has_dashboard_access()', 'anon', null::uuid, $q$select count(*) from (select 1 where public.has_dashboard_access()) s$q$, 'denied'),
          ('anon read allowlist', 'anon', null::uuid, $q$select count(*) from private.dashboard_members$q$, 'denied')
        ) v
        union all
        -- 3. Signed-in but NOT approved: sees nothing
        select 'pending read ' || t, 'authenticated (pending)', '00000000-0000-4000-8000-00000000a002'::uuid,
               format('select count(*) from public.%I', t), 'zero rows'
          from unnest(tables) t
        union all
        select 'revoked (is_active=false) read ' || t, 'authenticated (revoked)', '00000000-0000-4000-8000-00000000a003'::uuid,
               format('select count(*) from public.%I', t), 'zero rows'
          from unnest(array['cities','orders','refunds']) t
        union all
        select * from (values
          ('pending has_dashboard_access() is false', 'authenticated (pending)', '00000000-0000-4000-8000-00000000a002'::uuid,
            $q$select count(*) from (select 1 where public.has_dashboard_access()) s$q$, 'zero rows'),
          -- 6. Self-approval prevention
          ('pending self-approve (insert allowlist)', 'authenticated (pending)', '00000000-0000-4000-8000-00000000a002'::uuid,
            $q$insert into private.dashboard_members (user_id, approved_by) values ('00000000-0000-4000-8000-00000000a002', 'me')$q$, 'denied'),
          ('revoked self-reactivate (update allowlist)', 'authenticated (revoked)', '00000000-0000-4000-8000-00000000a003'::uuid,
            $q$update private.dashboard_members set is_active = true where user_id = '00000000-0000-4000-8000-00000000a003'$q$, 'denied'),
          ('pending read allowlist', 'authenticated (pending)', '00000000-0000-4000-8000-00000000a002'::uuid,
            $q$select count(*) from private.dashboard_members$q$, 'denied'),
          ('approved approves someone else', 'authenticated (approved)', '00000000-0000-4000-8000-00000000a001'::uuid,
            $q$insert into private.dashboard_members (user_id, approved_by) values ('00000000-0000-4000-8000-00000000a002', 'friend')$q$, 'denied'),
          ('approved deletes allowlist rows', 'authenticated (approved)', '00000000-0000-4000-8000-00000000a001'::uuid,
            $q$delete from private.dashboard_members where false$q$, 'denied')
        ) v
        union all
        -- 4. Approved user: read access to all 11 tables
        select 'approved read ' || t, 'authenticated (approved)', '00000000-0000-4000-8000-00000000a001'::uuid,
               format('select count(*) from public.%I', t), 'has rows'
          from unnest(tables) t
        union all
        select 'approved has_dashboard_access() is true', 'authenticated (approved)', '00000000-0000-4000-8000-00000000a001'::uuid,
               $q$select count(*) from (select 1 where public.has_dashboard_access()) s$q$, 'has rows'
        union all
        -- 5. Approved user: every write path denied on every table
        select 'approved insert ' || t, 'authenticated (approved)', '00000000-0000-4000-8000-00000000a001'::uuid,
               format('insert into public.%I default values', t), 'denied'
          from unnest(tables) t
        union all
        select 'approved update ' || t, 'authenticated (approved)', '00000000-0000-4000-8000-00000000a001'::uuid,
               format('update public.%I set created_at = created_at where false', t), 'denied'
          from unnest(tables) t
        union all
        select 'approved delete ' || t, 'authenticated (approved)', '00000000-0000-4000-8000-00000000a001'::uuid,
               format('delete from public.%I where false', t), 'denied'
          from unnest(tables) t
        union all
        select 'approved truncate ' || t, 'authenticated (approved)', '00000000-0000-4000-8000-00000000a001'::uuid,
               format('truncate public.%I cascade', t), 'denied'
          from unnest(tables) t
        union all
        select * from (values
          ('approved nextval on event id sequence', 'authenticated (approved)', '00000000-0000-4000-8000-00000000a001'::uuid,
            $q$select nextval(pg_get_serial_sequence('public.inventory_events', 'id'))$q$, 'denied'),
          ('approved calls internal is_valid_order_transition()', 'authenticated (approved)', '00000000-0000-4000-8000-00000000a001'::uuid,
            $q$select count(*) from (select public.is_valid_order_transition('placed', 'confirmed') as v) s where s.v is not null$q$, 'denied'),
          -- Future objects do not inherit client access
          ('approved read NEW table (default privileges)', 'authenticated (approved)', '00000000-0000-4000-8000-00000000a001'::uuid,
            $q$select count(*) from public.zz_rls_probe_table$q$, 'denied'),
          ('approved read NEW view (default privileges)', 'authenticated (approved)', '00000000-0000-4000-8000-00000000a001'::uuid,
            $q$select count(*) from public.zz_rls_probe_view$q$, 'denied'),
          ('anon read NEW view (default privileges)', 'anon', null::uuid,
            $q$select count(*) from public.zz_rls_probe_view$q$, 'denied'),
          -- Server-side role still works (for seeding later; never in React)
          ('service_role reads orders (bypasses RLS)', 'service_role', null::uuid,
            $q$select count(*) from public.orders$q$, 'has rows')
        ) v
      )
      select * from cases
    loop
      select * into res from pg_temp.qo_run_as(split_part(r.actor, ' ', 1), r.uid, r.sql);
      act := case
        when not res.ok and res.err like '42501%' then 'denied'
        when not res.ok then 'error: ' || res.err
        when res.row_count = 0 then 'zero rows'
        else 'has rows'
      end;
      names := names || r.test; actors := actors || r.actor; exps := exps || r.expected;
      acts := acts || (act || case when act = 'has rows' then ' (' || res.row_count || ')' else '' end);
      passes := passes || (act = r.expected);
    end loop;

    raise exception using message = '__qo_rollback_fixtures__';
  exception when others then
    if sqlerrm <> '__qo_rollback_fixtures__' then
      raise;  -- unexpected error: the whole statement aborts, nothing persists
    end if;
  end;

  return query
    select i, names[i], actors[i], exps[i], acts[i], passes[i]
    from generate_subscripts(names, 1) as i;
end;
$fn$;

-- Results: every row should show pass = true. Last row is the summary.
with results as materialized (
  select * from pg_temp.qo_rls_tests()
)
select n, test, actor, expected, actual, pass from results
union all
select null, format('SUMMARY: %s passed, %s failed',
                    count(*) filter (where pass), count(*) filter (where not pass)),
       '', '', '', bool_and(pass)
from results
order by 1 nulls last;
