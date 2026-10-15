-- =============================================================================
-- QuickOps IQ · Read-only Realtime compatibility check (run BEFORE 004)
-- =============================================================================
-- Pure SELECT: reads catalog metadata only. Changes nothing.
-- Output: one table (section, item, value). Contains no secrets; safe to share.
-- =============================================================================
with
send_fn  as (select to_regprocedure('realtime.send(jsonb, text, text, boolean)') as oid),
topic_fn as (select to_regprocedure('realtime.topic()') as oid),
msgs     as (select to_regclass('realtime.messages') as oid),
today    as (select (now() at time zone 'utc')::date as d)
select * from (
  -- environment ---------------------------------------------------------------
  select 1 as ord, 'environment' as section, 'server version' as item, current_setting('server_version') as value
  union all select 2, 'environment', 'current user (expect postgres)', current_user::text
  union all select 3, 'environment', 'business tables in supabase_realtime publication (expect 0)',
    (select count(*)::text from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public')

  -- realtime.messages ---------------------------------------------------------
  union all select 10, 'realtime.messages', 'exists', (select (oid is not null)::text from msgs)
  union all select 11, 'realtime.messages', 'relkind (p = partitioned) / RLS enabled / RLS forced',
    (select c.relkind::text || ' / ' || c.relrowsecurity::text || ' / ' || c.relforcerowsecurity::text
       from pg_class c where c.oid = (select oid from msgs))
  union all select 12, 'realtime.messages', 'columns',
    (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum)
       from pg_attribute a where a.attrelid = (select oid from msgs) and a.attnum > 0 and not a.attisdropped)
  union all select 13, 'realtime.messages', 'partition for today (UTC) exists',
    (select coalesce(bool_or(pg_get_expr(c.relpartbound, c.oid) like '%' || (select d from today)::text || '%'), false)::text
       from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = (select oid from msgs))
  union all select 14, 'realtime.messages', 'partitions (count, newest)',
    (select count(*)::text || ', ' || coalesce(max(c.relname), '-')
       from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = (select oid from msgs))
  union all select 15, 'realtime.messages', 'table privileges by role',
    (select string_agg(r || ': ' || coalesce(nullif(concat_ws(',',
        case when has_table_privilege(r, (select oid from msgs), 'SELECT') then 'SELECT' end,
        case when has_table_privilege(r, (select oid from msgs), 'INSERT') then 'INSERT' end,
        case when has_table_privilege(r, (select oid from msgs), 'UPDATE') then 'UPDATE' end,
        case when has_table_privilege(r, (select oid from msgs), 'DELETE') then 'DELETE' end), ''), 'none'), ' | ')
       from unnest(array['anon', 'authenticated', 'service_role', 'postgres']) r)

  -- existing policies on realtime.messages ------------------------------------
  union all select 20, 'realtime.messages policies', 'count', (select count(*)::text from pg_policies where schemaname = 'realtime' and tablename = 'messages')
  union all
  select 21, 'realtime.messages policies',
         p.policyname || '  [' || p.permissive || ', ' || p.cmd || ', roles=' || array_to_string(p.roles, ',') || ']',
         'USING: ' || coalesce(p.qual, '(none)') || '  |  WITH CHECK: ' || coalesce(p.with_check, '(none)')
  from pg_policies p where p.schemaname = 'realtime' and p.tablename = 'messages'

  -- realtime.send -------------------------------------------------------------
  union all select 30, 'realtime.send', 'exists with (jsonb, text, text, boolean)', (select (oid is not null)::text from send_fn)
  union all select 31, 'realtime.send', 'arguments (with defaults)', (select pg_get_function_arguments(oid) from send_fn)
  union all select 32, 'realtime.send', 'returns / language / security definer / owner',
    (select format_type(p.prorettype, null) || ' / ' || l.lanname || ' / ' || p.prosecdef::text || ' / ' || pg_get_userbyid(p.proowner)
       from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = (select oid from send_fn))
  union all select 33, 'realtime.send', 'settings (proconfig)', (select coalesce(array_to_string(proconfig, '; '), '(none)') from pg_proc where oid = (select oid from send_fn))
  union all select 34, 'realtime.send', 'EXECUTE by role',
    (select string_agg(r || '=' || coalesce(has_function_privilege(r, (select oid from send_fn), 'EXECUTE')::text, 'n/a'), ', ')
       from unnest(array['postgres', 'service_role', 'authenticated', 'anon']) r)
  union all select 35, 'realtime.send', 'source (whitespace collapsed)',
    (select left(regexp_replace(prosrc, '\s+', ' ', 'g'), 900) from pg_proc where oid = (select oid from send_fn))
  union all select 36, 'realtime.send', 'other overloads',
    (select coalesce(string_agg(pg_get_function_identity_arguments(p.oid), ' || '), '(none)')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'realtime' and p.proname = 'send' and p.oid <> (select oid from send_fn))

  -- realtime.topic ------------------------------------------------------------
  union all select 40, 'realtime.topic', 'exists', (select (oid is not null)::text from topic_fn)
  union all select 41, 'realtime.topic', 'source', (select regexp_replace(prosrc, '\s+', ' ', 'g') from pg_proc where oid = (select oid from topic_fn))
  union all select 42, 'realtime.topic', 'EXECUTE by authenticated', (select has_function_privilege('authenticated', oid, 'EXECUTE')::text from topic_fn)

  -- name collisions / rerun safety --------------------------------------------
  union all select 50, 'collisions', 'function private.broadcast_analytics_change exists',
    (to_regprocedure('private.broadcast_analytics_change()') is not null)::text
  union all select 51, 'collisions', 'trigger orders_analytics_signal exists',
    (select (count(*) > 0)::text from pg_trigger where tgname = 'orders_analytics_signal' and tgrelid = 'public.orders'::regclass)
  union all select 52, 'collisions', 'trigger refunds_analytics_signal exists',
    (select (count(*) > 0)::text from pg_trigger where tgname = 'refunds_analytics_signal' and tgrelid = 'public.refunds'::regclass)
  union all select 53, 'collisions', 'policy quickops_analytics_signal_receive exists',
    (select (count(*) > 0)::text from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'quickops_analytics_signal_receive')
  union all select 54, 'collisions', 'existing non-internal triggers on orders / refunds',
    (select coalesce(string_agg(t.tgrelid::regclass::text || '.' || t.tgname, ', '), '(none)')
       from pg_trigger t where t.tgrelid in ('public.orders'::regclass, 'public.refunds'::regclass) and not t.tgisinternal)

  -- membership function used by the new policy --------------------------------
  union all select 60, 'membership', 'private.is_dashboard_member: definer / EXECUTE by authenticated / by anon',
    (select p.prosecdef::text || ' / ' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || ' / '
            || has_function_privilege('anon', p.oid, 'EXECUTE')::text
       from pg_proc p where p.oid = to_regprocedure('private.is_dashboard_member()'))
  union all select 61, 'membership', 'authenticated has USAGE on schema private / realtime',
    has_schema_privilege('authenticated', 'private', 'USAGE')::text || ' / ' || has_schema_privilege('authenticated', 'realtime', 'USAGE')::text
) checks
order by ord, item;
