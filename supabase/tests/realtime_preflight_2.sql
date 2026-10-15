-- =============================================================================
-- QuickOps IQ · Read-only Realtime preflight, part 2 (run BEFORE 004)
-- =============================================================================
-- Pure SELECT on catalog metadata. Changes nothing. Output: (section, item, value).
-- Answers: who can actually write orders/refunds, and can those roles make
-- realtime.send persist a message (privileges + RLS bypass on realtime.messages)?
-- Re-run section "partitions" after opening the dashboard to see if a client
-- connection created today's partition.
-- =============================================================================
with msgs as (select to_regclass('realtime.messages') as oid)
select * from (
  -- who can write the business tables (grants), and do RLS/policies allow it?
  select 1 as ord, 'write roles' as section, 'owner of public.orders / public.refunds' as item,
    pg_get_userbyid((select relowner from pg_class where oid = 'public.orders'::regclass)) || ' / ' ||
    pg_get_userbyid((select relowner from pg_class where oid = 'public.refunds'::regclass)) as value
  union all
  select 2, 'write roles', 'INSERT/UPDATE/DELETE privilege on orders, refunds by role',
    string_agg(r || ': orders=' ||
      concat_ws(',', case when has_table_privilege(r, 'public.orders', 'INSERT') then 'I' end,
                     case when has_table_privilege(r, 'public.orders', 'UPDATE') then 'U' end,
                     case when has_table_privilege(r, 'public.orders', 'DELETE') then 'D' end)
      || ' refunds=' ||
      concat_ws(',', case when has_table_privilege(r, 'public.refunds', 'INSERT') then 'I' end,
                     case when has_table_privilege(r, 'public.refunds', 'UPDATE') then 'U' end,
                     case when has_table_privilege(r, 'public.refunds', 'DELETE') then 'D' end), ' | ')
  from unnest(array['postgres', 'service_role', 'authenticated', 'anon']) r
  union all
  select 3, 'write roles', 'write policies on orders/refunds (expect 0: clients cannot write)',
    (select count(*)::text from pg_policies where schemaname = 'public' and tablename in ('orders', 'refunds') and cmd <> 'SELECT')
  union all
  select 4, 'write roles', 'functions that write orders/refunds (definer functions in public/private)',
    (select coalesce(string_agg(n.nspname || '.' || p.proname || ' [definer=' || p.prosecdef || ']', ', '), '(none)')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')
        and p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?(orders|refunds)\b')

  -- can those roles make realtime.send persist? (send is SECURITY INVOKER)
  union all
  select 10, 'realtime.send under writer roles', 'role: login / bypassrls / INSERT on realtime.messages',
    string_agg(r.rolname || ': ' || r.rolcanlogin || ' / ' || r.rolbypassrls || ' / ' ||
               has_table_privilege(r.rolname, (select oid from msgs), 'INSERT'), ' | ' order by r.rolname)
  from pg_roles r where r.rolname in ('postgres', 'service_role', 'authenticated', 'anon', 'supabase_realtime_admin')
  union all
  select 11, 'realtime.send under writer roles', 'INSERT policies on realtime.messages (non-bypass roles need one)',
    (select count(*)::text from pg_policies where schemaname = 'realtime' and tablename = 'messages' and cmd in ('INSERT', 'ALL'))
  union all
  select 12, 'realtime.send under writer roles', 'send body: catches all errors / references realtime.messages / sets config',
    (select (prosrc ~* 'exception\s+when\s+others')::text || ' / ' || (prosrc ~* 'realtime\.messages')::text || ' / '
            || (prosrc ~* 'set_config|set\s+local')::text
       from pg_proc where oid = to_regprocedure('realtime.send(jsonb, text, text, boolean)'))

  -- partitions (re-run after opening the dashboard)
  union all
  select 20, 'partitions', 'count / oldest / newest',
    (select count(*)::text || ' / ' || coalesce(min(c.relname), '-') || ' / ' || coalesce(max(c.relname), '-')
       from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = (select oid from msgs))
  union all
  select 21, 'partitions', 'today (UTC)', (now() at time zone 'utc')::date::text
  union all
  select 22, 'partitions', 'recent signal messages on quickops:analytics (last 1 day)',
    (select count(*)::text from realtime.messages where topic = 'quickops:analytics' and inserted_at > now() - interval '1 day')
) checks
order by ord, item;
