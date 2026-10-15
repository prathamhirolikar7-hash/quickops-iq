-- =============================================================================
-- QuickOps IQ · Tests for migration 004 (Realtime analytics signals)
-- =============================================================================
-- Run in the Supabase SQL Editor AFTER 004 is applied.
--   * Everything runs in a subtransaction that is ALWAYS rolled back. Rolled
--     back signals are never broadcast (Realtime only delivers committed
--     messages). Statements that touch business rows are no-ops (WHERE false
--     or SET col = col) and are rolled back too. No data changes.
--   * Output: one row per check (21 checks); last row is the summary.
--   * Keep the dashboard open (signed in) before running: a connected Realtime
--     client creates the daily partition that realtime.send needs.
-- =============================================================================

create or replace function pg_temp.rt_val(p_role text, p_uid uuid, p_topic text, p_sql text,
                                          out ok boolean, out val text, out err text)
language plpgsql as $$
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
    perform set_config('realtime.topic', coalesce(p_topic, ''), true);
    perform set_config('role', p_role, true);
    execute p_sql into val;
    raise exception using message = '__rt_ok__';
  exception when others then
    if sqlerrm = '__rt_ok__' then ok := true; err := null;
    else ok := false; val := null; err := sqlstate || ' ' || sqlerrm; end if;
  end;
end;
$$;

create or replace function pg_temp.rt_check(p_area text, p_test text, p_expected text, p_ok boolean, p_val text, p_err text)
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

create or replace function pg_temp.rt_tests()
returns table (n int, area text, test text, expected text, actual text, pass boolean)
language plpgsql as $fn$
declare
  M constant uuid := '00000000-0000-4000-8000-00000000d001'; -- approved (throwaway)
  P constant uuid := '00000000-0000-4000-8000-00000000d002'; -- pending (throwaway)
  T constant text := 'quickops:analytics';
  res jsonb := '[]';
  r record;
  before_n bigint;
  after_n bigint;
  last_msg record;
  count_sql constant text := $q$select count(*)::text from realtime.messages where topic = 'quickops:analytics'$q$;
begin
  if current_user <> 'postgres' then
    raise exception 'Run as postgres (Supabase SQL Editor)';
  end if;
  if to_regprocedure('private.broadcast_analytics_change()') is null then
    raise exception 'Migration 004_realtime_signals.sql is not installed.';
  end if;

  begin -- ALWAYS rolled back
    insert into auth.users (id, email, aud, role) values
      (M, 'rt-approved@example.invalid', 'authenticated', 'authenticated'),
      (P, 'rt-pending@example.invalid',  'authenticated', 'authenticated');
    insert into private.dashboard_members (user_id, approved_by) values (M, 'realtime-test');

    ------------------------------------------------------------ 0. preconditions
    -- If these fail, the emission checks below fail for an environmental reason
    -- (no daily partition, or a writer that cannot store messages), not a 004 bug.
    res := res || pg_temp.rt_check('precondition', 'partition for today exists', 'true', true,
      (select case
         when c.relkind <> 'p' then 'true' -- not partitioned (local emulation): nothing to check
         else exists (
           select 1 from pg_inherits i join pg_class p on p.oid = i.inhrelid
           where i.inhparent = c.oid
             and p.relname = 'messages_' || to_char((now() at time zone 'utc')::date, 'YYYY_MM_DD'))::text
       end
       from pg_class c where c.oid = 'realtime.messages'::regclass), null);
    res := res || pg_temp.rt_check('precondition', 'writer role has INSERT + BYPASSRLS', 'true|true', true,
      has_table_privilege(current_user, 'realtime.messages', 'INSERT')::text || '|' ||
      (select rolbypassrls::text from pg_roles where rolname = current_user), null);

    ------------------------------------------------------------ A. signal emission
    select count(*) into before_n from realtime.messages where topic = T;
    update public.orders set payment_method = payment_method
      where id in (select id from public.orders order by placed_at limit 50);
    select count(*) into after_n from realtime.messages where topic = T;
    res := res || pg_temp.rt_check('emission', 'UPDATE of 50 orders sends exactly 1 signal (per statement, not per row)',
                                   '1', true, (after_n - before_n)::text, null);

    before_n := after_n;
    update public.orders set status = status where false;
    select count(*) into after_n from realtime.messages where topic = T;
    res := res || pg_temp.rt_check('emission', 'zero-row UPDATE on orders still signals (statement trigger)',
                                   '1', true, (after_n - before_n)::text, null);

    before_n := after_n;
    delete from public.refunds where false;
    select count(*) into after_n from realtime.messages where topic = T;
    res := res || pg_temp.rt_check('emission', 'DELETE on refunds sends 1 signal', '1', true, (after_n - before_n)::text, null);

    before_n := after_n;
    update public.riders set status = status where false;
    update public.inventory set quantity_on_hand = quantity_on_hand where false;
    select count(*) into after_n from realtime.messages where topic = T;
    res := res || pg_temp.rt_check('emission', 'writes to tables without triggers send nothing', '0', true, (after_n - before_n)::text, null);

    select * into last_msg from realtime.messages where topic = T order by inserted_at desc, id desc limit 1;
    -- Supabase's realtime.send adds a random message id (gen_random_uuid(), also
    -- used as realtime.messages.id) when the payload has none. Our own keys must
    -- be exactly v, table, op, at; the added id must be that message id and must
    -- not match any business identifier.
    res := res || pg_temp.rt_check('payload', 'our payload keys are exactly v, table, op, at (Supabase message id excluded)',
                                   'at,op,table,v', true,
                                   (select string_agg(k, ',' order by k) from jsonb_object_keys(last_msg.payload - 'id') k), null);
    res := res || pg_temp.rt_check('payload', 'added id is the message''s own UUID and matches no order or refund id',
                                   'true', true,
                                   (last_msg.payload ? 'id'
                                    and (last_msg.payload ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                    and (last_msg.payload ->> 'id') = last_msg.id::text
                                    and not exists (select 1 from public.orders  o where o.id::text = last_msg.payload ->> 'id')
                                    and not exists (select 1 from public.refunds f where f.id::text = last_msg.payload ->> 'id'))::text,
                                   null);
    res := res || pg_temp.rt_check('payload', 'event / extension / private flag',
                                   'analytics_changed|broadcast|true', true,
                                   last_msg.event || '|' || last_msg.extension || '|' || last_msg.private::text, null);

    ------------------------------------------------------------ B. who can receive (SELECT policy)
    select * into r from pg_temp.rt_val('authenticated', M, T, count_sql);
    res := res || pg_temp.rt_check('receive', 'approved member can read signals on the private topic', 'true',
                                   r.ok, (coalesce(r.val, '0')::int > 0)::text, r.err);
    select * into r from pg_temp.rt_val('authenticated', P, T, count_sql);
    res := res || pg_temp.rt_check('receive', 'pending (unapproved) user receives nothing', '0', r.ok, r.val, r.err);
    select * into r from pg_temp.rt_val('anon', null, T, count_sql);
    res := res || pg_temp.rt_check('receive', 'anonymous visitor receives nothing', '0', r.ok,
                                   coalesce(r.val, case when r.err like '42501%' then '0' end), case when r.err like '42501%' then null else r.err end);
    select * into r from pg_temp.rt_val('authenticated', M, 'some-other-topic', count_sql);
    res := res || pg_temp.rt_check('receive', 'approved member joining a different topic gets nothing from this policy', '0', r.ok, r.val, r.err);

    ------------------------------------------------------------ C. nobody can send (no INSERT policy)
    select * into r from pg_temp.rt_val('authenticated', M, T,
      $q$insert into realtime.messages (topic, extension, payload, event, private)
         values ('quickops:analytics', 'broadcast', '{"table":"orders","op":"insert"}', 'analytics_changed', true)
         returning 'inserted'$q$);
    res := res || pg_temp.rt_check('send', 'approved member cannot send (spoof) a signal', 'error 42501', r.ok, r.val, r.err);
    select * into r from pg_temp.rt_val('authenticated', P, T,
      $q$insert into realtime.messages (topic, extension, payload, event, private)
         values ('quickops:analytics', 'broadcast', '{}', 'analytics_changed', true) returning 'inserted'$q$);
    res := res || pg_temp.rt_check('send', 'pending user cannot send a signal', 'error 42501', r.ok, r.val, r.err);
    select * into r from pg_temp.rt_val('anon', null, T,
      $q$insert into realtime.messages (topic, extension, payload, event, private)
         values ('quickops:analytics', 'broadcast', '{}', 'analytics_changed', true) returning 'inserted'$q$);
    res := res || pg_temp.rt_check('send', 'anonymous visitor cannot send a signal', 'error 42501', r.ok, r.val, r.err);

    ------------------------------------------------------------ D. unchanged security surface
    res := res || pg_temp.rt_check('security', 'clients cannot EXECUTE the trigger function', 'false|false', true,
      has_function_privilege('anon', 'private.broadcast_analytics_change()', 'EXECUTE')::text || '|' ||
      has_function_privilege('authenticated', 'private.broadcast_analytics_change()', 'EXECUTE')::text, null);
    res := res || pg_temp.rt_check('security', 'trigger function is SECURITY INVOKER with search_path=''''', 'false|true', true,
      (select p.prosecdef::text || '|' || (p.proconfig @> array['search_path=""'])::text
       from pg_proc p where p.oid = 'private.broadcast_analytics_change()'::regprocedure), null);
    res := res || pg_temp.rt_check('security', 'business tables still NOT in the supabase_realtime publication', '0', true,
      (select count(*)::text from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'), null);
    res := res || pg_temp.rt_check('security', 'business-table RLS policies unchanged (11 read policies)', '11', true,
      (select count(*)::text from pg_policies where schemaname in ('public', 'private')), null);
    res := res || pg_temp.rt_check('security', 'pending user still reads 0 orders directly', '0', true,
      (select val from pg_temp.rt_val('authenticated', P, null, 'select count(*)::text from public.orders')), null);

    raise exception using message = '__rt_rollback__';
  exception when others then
    if sqlerrm <> '__rt_rollback__' then raise; end if;
  end;

  return query
    select (t.ord)::int, t.j ->> 'area', t.j ->> 'test', t.j ->> 'expected', t.j ->> 'actual', (t.j ->> 'pass')::boolean
    from jsonb_array_elements(res) with ordinality as t(j, ord);
end;
$fn$;

with results as materialized (select * from pg_temp.rt_tests())
select n, area, test, expected, actual, pass from results
union all
select null, 'SUMMARY', format('%s passed, %s failed', count(*) filter (where pass), count(*) filter (where not pass)),
       '', '', bool_and(pass)
from results
order by 1 nulls last;
