-- =============================================================================
-- QuickOps IQ · Tests for migration 005 (demo order simulator)
-- =============================================================================
-- Run in the Supabase SQL Editor AFTER 005 is applied.
--   * Everything (throwaway users, simulated orders, stock movements, the reset)
--     runs in a subtransaction that is ALWAYS rolled back. Nothing persists.
--   * Simulated time is fast-forwarded by moving the throwaway orders' planned
--     timestamps back one hour, so the full lifecycle completes in one run.
--   * Output: one row per check; last row is the summary.
-- =============================================================================

create or replace function pg_temp.sim_val(p_role text, p_uid uuid, p_sql text,
                                           out ok boolean, out val text, out err text)
language plpgsql as $$
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
    perform set_config('role', p_role, true);
    execute p_sql into val;
    raise exception using message = '__sim_ok__';
  exception when others then
    if sqlerrm = '__sim_ok__' then ok := true; err := null;
    else ok := false; val := null; err := sqlstate || ' ' || sqlerrm; end if;
  end;
end;
$$;

-- Like sim_val, but KEEPS the statement's effects (used for operator ticks)
create or replace function pg_temp.sim_run(p_uid uuid, p_sql text) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into v;
  perform set_config('role', 'postgres', true);
  return v;
end;
$$;

create or replace function pg_temp.sim_check(p_area text, p_test text, p_expected text, p_ok boolean, p_val text, p_err text)
returns jsonb language plpgsql as $$
declare v_actual text; v_pass boolean;
begin
  if p_expected like 'error %' then
    v_pass := not p_ok and p_err like substr(p_expected, 7) || '%';
    v_actual := case when p_ok then 'ok: ' || coalesce(p_val, 'null') else 'error ' || p_err end;
  else
    v_actual := case when p_ok then coalesce(p_val, 'null') else 'error ' || p_err end;
    v_pass := p_ok and coalesce(p_val, 'null') = p_expected;
  end if;
  return jsonb_build_array(jsonb_build_object('area', p_area, 'test', p_test, 'expected', p_expected,
                                              'actual', left(v_actual, 140), 'pass', coalesce(v_pass, false)));
end;
$$;

-- Business-data checksum (everything the simulator could touch). inventory.updated_at
-- is excluded: the 001 trigger legitimately stamps it when reset restores stock.
create or replace function pg_temp.sim_fingerprint() returns text language sql as $$
  select concat_ws('|',
    (select count(*) || ':' || coalesce(sum(hashtextextended(o::text, 0)::numeric), 0) from public.orders o),
    (select count(*) || ':' || coalesce(sum(hashtextextended(i::text, 0)::numeric), 0) from public.order_items i),
    (select count(*) || ':' || coalesce(sum(hashtextextended(e::text, 0)::numeric), 0) from public.inventory_events e),
    (select count(*) || ':' || coalesce(sum(hashtextextended((v.id, v.quantity_on_hand, v.reorder_level, v.last_restocked_at)::text, 0)::numeric), 0) from public.inventory v),
    (select count(*) || ':' || coalesce(sum(hashtextextended(s::text, 0)::numeric), 0) from public.order_status_events s),
    (select count(*) || ':' || coalesce(sum(hashtextextended(d::text, 0)::numeric), 0) from public.delivery_events d),
    (select count(*) || ':' || coalesce(sum(hashtextextended(r::text, 0)::numeric), 0) from public.refunds r))
$$;

create or replace function pg_temp.sim_tests()
returns table (n int, area text, test text, expected text, actual text, pass boolean)
language plpgsql as $fn$
declare
  O constant uuid := '00000000-0000-4000-8000-00000000f001'; -- operator (throwaway)
  V constant uuid := '00000000-0000-4000-8000-00000000f002'; -- viewer (throwaway)
  P constant uuid := '00000000-0000-4000-8000-00000000f003'; -- pending (throwaway)
  A constant text := 'authenticated';
  res jsonb := '[]';
  r record;
  j jsonb;
  v_fp_before text;
  v_sim_before int;
  v_msgs_before bigint;
  v_new uuid[];
  v_before_ids uuid[];
begin
  if current_user <> 'postgres' then raise exception 'Run as postgres (Supabase SQL Editor)'; end if;
  if to_regprocedure('private.sim_tick(text, integer)') is null then
    raise exception 'Migration 005_order_simulator.sql is not installed.';
  end if;

  begin -- ALWAYS rolled back
    v_fp_before := pg_temp.sim_fingerprint();
    select count(*) into v_sim_before from public.orders where order_number like 'SIM-%';
    insert into auth.users (id, email, aud, role) values
      (O, 'sim-operator@example.invalid', 'authenticated', 'authenticated'),
      (V, 'sim-viewer@example.invalid',   'authenticated', 'authenticated'),
      (P, 'sim-pending@example.invalid',  'authenticated', 'authenticated');
    insert into private.dashboard_members (user_id, approved_by, role) values
      (O, 'simulator-test', 'operator'), (V, 'simulator-test', 'viewer');

    ------------------------------------------------------------ A. who may simulate
    select * into r from pg_temp.sim_val('anon', null, $q$select public.simulator_tick('normal', 1)::text$q$);
    res := res || pg_temp.sim_check('access', 'anonymous visitor cannot run a tick', 'error 42501', r.ok, r.val, r.err);
    select * into r from pg_temp.sim_val('anon', null, $q$select public.simulator_status()::text$q$);
    res := res || pg_temp.sim_check('access', 'anonymous visitor cannot read simulator status', 'error 42501', r.ok, r.val, r.err);
    select * into r from pg_temp.sim_val(A, P, $q$select public.simulator_tick('normal', 1)::text$q$);
    res := res || pg_temp.sim_check('access', 'signed-in but unapproved user cannot run a tick', 'error 42501', r.ok, r.val, r.err);
    select * into r from pg_temp.sim_val(A, V, $q$select public.simulator_tick('normal', 1)::text$q$);
    res := res || pg_temp.sim_check('access', 'viewer cannot run a tick', 'error 42501', r.ok, r.val, r.err);
    select * into r from pg_temp.sim_val(A, V, $q$select public.simulator_reset()::text$q$);
    res := res || pg_temp.sim_check('access', 'viewer cannot reset', 'error 42501', r.ok, r.val, r.err);
    select * into r from pg_temp.sim_val(A, V, $q$select public.simulator_status()::text$q$);
    res := res || pg_temp.sim_check('access', 'viewer cannot read simulator status', 'error 42501', r.ok, r.val, r.err);
    res := res || pg_temp.sim_check('access', 'my_dashboard_role: operator / viewer / unapproved',
      'operator|viewer|null', true,
      (select val from pg_temp.sim_val(A, O, 'select public.my_dashboard_role()')) || '|' ||
      (select val from pg_temp.sim_val(A, V, 'select public.my_dashboard_role()')) || '|' ||
      coalesce((select val from pg_temp.sim_val(A, P, 'select public.my_dashboard_role()')), 'null'), null);
    select * into r from pg_temp.sim_val(A, O, $q$select count(*)::text from private.sim_order_plan$q$);
    res := res || pg_temp.sim_check('access', 'even operators cannot read private simulator tables directly', 'error 42501', r.ok, r.val, r.err);
    select * into r from pg_temp.sim_val(A, O,
      $q$insert into public.orders (order_number, store_id, city_id, payment_method, item_total_paise, sla_deadline_at)
         select 'SIM-999999', id, city_id, 'upi', 0, now() + interval '10 min' from public.dark_stores limit 1 returning 'x'$q$);
    res := res || pg_temp.sim_check('access', 'operators still have NO direct write access to business tables', 'error 42501', r.ok, r.val, r.err);
    res := res || pg_temp.sim_check('access', 'internal helpers not executable by client roles', 'false|false|false', true,
      has_function_privilege('authenticated', 'private.sim_create_order(text, uuid)', 'EXECUTE')::text || '|' ||
      has_function_privilege('authenticated', 'private.sim_advance(uuid, timestamptz)', 'EXECUTE')::text || '|' ||
      has_function_privilege('anon', 'public.simulator_tick(text, integer)', 'EXECUTE')::text, null);
    res := res || pg_temp.sim_check('access', 'SECURITY DEFINER functions are exactly the expected set, all with search_path=''''',
      'private.is_dashboard_member,private.is_dashboard_operator,private.sim_reset,private.sim_status,private.sim_tick|true', true,
      (select string_agg(n.nspname || '.' || p.proname, ',' order by p.proname) || '|' ||
              bool_and(p.proconfig @> array['search_path=""'])::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and p.prosecdef), null);

    ------------------------------------------------------------ B. input validation and limits
    update private.sim_state set last_tick_at = null;
    select * into r from pg_temp.sim_val(A, O, $q$select public.simulator_tick('hurricane', 1)::text$q$);
    res := res || pg_temp.sim_check('limits', 'unknown scenario rejected', 'error 22023', r.ok, r.val, r.err);
    select * into r from pg_temp.sim_val(A, O, $q$select public.simulator_tick('normal', 26)::text$q$);
    res := res || pg_temp.sim_check('limits', 'more than 25 new orders per tick rejected', 'error 22023', r.ok, r.val, r.err);
    update private.sim_state set last_tick_at = clock_timestamp();
    select * into r from pg_temp.sim_val(A, O, $q$select public.simulator_tick('normal', 1)::text$q$);
    res := res || pg_temp.sim_check('limits', 'ticks faster than every 2 seconds are rate limited', 'error QO429', r.ok, r.val, r.err);

    ------------------------------------------------------------ C. lifecycle
    select count(*) into v_msgs_before from realtime.messages where topic = 'quickops:analytics';
    select coalesce(array_agg(id), '{}') into v_before_ids from public.orders where order_number like 'SIM-%';
    update private.sim_state set last_tick_at = null;
    j := pg_temp.sim_run(O, $q$select public.simulator_tick('normal', 6)$q$);
    update private.sim_state set last_tick_at = null;
    j := pg_temp.sim_run(O, $q$select public.simulator_tick('stockout', 6)$q$);
    select array_agg(id) into v_new from public.orders
    where order_number like 'SIM-%' and not (id = any (v_before_ids));
    res := res || pg_temp.sim_check('lifecycle', 'two ticks created 12 SIM orders, all placed', '12|placed', true,
      (select count(*)::text || '|' || string_agg(distinct status, ',') from public.orders where id = any (v_new)), null);
    res := res || pg_temp.sim_check('lifecycle', 'each new order has items and item_total = sum of lines', 'true', true,
      (select bool_and(o.item_total_paise = (select sum(line_total_paise) from public.order_items i where i.order_id = o.id))::text
       from public.orders o where o.id = any (v_new)), null);
    res := res || pg_temp.sim_check('lifecycle', 'writes emitted Realtime signals (live dashboards refresh)', 'true', true,
      ((select count(*) from realtime.messages where topic = 'quickops:analytics') > v_msgs_before)::text, null);

    -- fast-forward these orders' plans by one hour, then tick to completion
    update private.sim_order_plan set
      confirm_at = confirm_at - interval '1 hour', pick_start_at = pick_start_at - interval '1 hour',
      pick_done_at = pick_done_at - interval '1 hour', pack_done_at = pack_done_at - interval '1 hour',
      rider_assign_at = rider_assign_at - interval '1 hour', dispatch_at = dispatch_at - interval '1 hour',
      arrive_at = arrive_at - interval '1 hour', finish_at = finish_at - interval '1 hour',
      cancel_at = cancel_at - interval '1 hour'
    where order_id = any (v_new);
    update public.orders set placed_at = placed_at - interval '1 hour', sla_deadline_at = sla_deadline_at - interval '1 hour',
                             created_at = created_at - interval '1 hour'
    where id = any (v_new);
    update public.order_status_events set occurred_at = occurred_at - interval '1 hour', created_at = created_at - interval '1 hour'
    where order_id = any (v_new) and to_status = 'placed';
    update private.sim_state set last_tick_at = null;
    j := pg_temp.sim_run(O, $q$select public.simulator_tick('normal', 0)$q$);

    res := res || pg_temp.sim_check('lifecycle', 'all 12 reached a final state (delivered or cancelled)', '0', true,
      (select count(*)::text from public.orders where id = any (v_new) and status not in ('delivered', 'cancelled')), null);
    res := res || pg_temp.sim_check('lifecycle', 'status history follows valid transitions and ends at the current status', '0', true,
      (select count(*)::text from public.orders o where o.id = any (v_new) and (
         exists (select 1 from (select e.from_status, lag(e.to_status) over (order by e.occurred_at, e.id) prev
                                from public.order_status_events e where e.order_id = o.id) s
                 where s.from_status is distinct from s.prev)
         or (select e.to_status from public.order_status_events e where e.order_id = o.id
             order by e.occurred_at desc, e.id desc limit 1) is distinct from o.status)), null);
    res := res || pg_temp.sim_check('lifecycle', 'delivered SIM orders have all 7 delivery milestones', '0', true,
      (select count(*)::text from public.orders o where o.id = any (v_new) and o.status = 'delivered'
         and (select count(*) from public.delivery_events d where d.order_id = o.id) <> 7), null);
    res := res || pg_temp.sim_check('lifecycle', 'sale stock movements equal fulfilled quantities', '0', true,
      (select count(*)::text from public.order_items i where i.order_id = any (v_new)
         and i.quantity_fulfilled <> coalesce((select -sum(e.quantity_change) from public.inventory_events e
                                               where e.order_id = i.order_id and e.product_id = i.product_id and e.event_type = 'sale'), 0)), null);
    res := res || pg_temp.sim_check('lifecycle', 'stock ledger stays consistent (running sum = quantity_after)', '0', true,
      (select count(*)::text from (
         select e.quantity_after, sum(e.quantity_change) over (partition by e.store_id, e.product_id
                                    order by e.occurred_at, e.id rows between unbounded preceding and current row) run
         from public.inventory_events e
         where (e.store_id, e.product_id) in (select o.store_id, i.product_id from public.orders o
                                              join public.order_items i on i.order_id = o.id where o.id = any (v_new))) x
       where x.run <> x.quantity_after), null);
    res := res || pg_temp.sim_check('lifecycle', 'refunds never exceed the amount paid', '0', true,
      (select count(*)::text from public.orders o where o.id = any (v_new)
         and (select coalesce(sum(rf.amount_paise), 0) from public.refunds rf where rf.order_id = o.id) > o.total_paise), null);
    res := res || pg_temp.sim_check('lifecycle', 'operator status reflects the run (open 0, created >= 12)', 'true', true,
      ((j ->> 'open_orders')::int = 0 and (j ->> 'total_orders')::int >= 12)::text, null);

    ------------------------------------------------------------ D. reset restores the seed exactly
    j := pg_temp.sim_run(O, $q$select public.simulator_reset()$q$);
    res := res || pg_temp.sim_check('reset', 'reset removed every SIM order', '0', true,
      (select count(*)::text from public.orders where order_number like 'SIM-%'), null);
    -- Only meaningful when no simulated orders existed before the test (reset
    -- correctly removes those too); otherwise reported as not applicable.
    res := res || pg_temp.sim_check('reset', 'business data identical to before the test (excluding inventory.updated_at)',
      case when v_sim_before = 0 then 'true' else format('n/a: %s SIM orders existed before the test', v_sim_before) end, true,
      case when v_sim_before = 0 then (pg_temp.sim_fingerprint() = v_fp_before)::text
           else format('n/a: %s SIM orders existed before the test', v_sim_before) end, null);
    res := res || pg_temp.sim_check('reset', 'no simulator tracking rows left behind', '0|0', true,
      (select count(*)::text from private.sim_order_plan) || '|' || (select count(*)::text from private.sim_inventory_events), null);

    raise exception using message = '__sim_rollback__';
  exception when others then
    if sqlerrm <> '__sim_rollback__' then raise; end if;
  end;

  return query
    select (t.ord)::int, t.j ->> 'area', t.j ->> 'test', t.j ->> 'expected', t.j ->> 'actual', (t.j ->> 'pass')::boolean
    from jsonb_array_elements(res) with ordinality as t(j, ord);
end;
$fn$;

with results as materialized (select * from pg_temp.sim_tests())
select n, area, test, expected, actual, pass from results
union all
select null, 'SUMMARY', format('%s passed, %s failed', count(*) filter (where pass), count(*) filter (where not pass)),
       '', '', bool_and(pass)
from results
order by 1 nulls last;
