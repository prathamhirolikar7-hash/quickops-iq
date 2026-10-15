-- =============================================================================
-- QuickOps IQ · Read-only security verification queries
-- =============================================================================
-- Run each query separately in the Supabase SQL Editor. Nothing here modifies
-- data. "Expected" notes describe the state after migration 002.
-- =============================================================================

-- Q1. RLS status of every table in public and private
--     Expected: rls_enabled = true for all 11 public tables + private.dashboard_members.
--     rls_forced = false (owner-level bypass is needed by the membership function).
select n.nspname as schema, c.relname as table_name,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and n.nspname in ('public', 'private')
order by 1, 2;

-- Q2. All RLS policies
--     Expected: exactly 11 rows, one "dashboard_members_read" per public table,
--     cmd = SELECT, roles = {authenticated}, qual calls private.is_dashboard_member().
--     No INSERT/UPDATE/DELETE/ALL policies, and none for anon or public.
select schemaname, tablename, policyname, cmd, roles, permissive, qual, with_check
from pg_policies
where schemaname in ('public', 'private')
order by tablename, policyname;

-- Q3. Table privileges held by client roles
--     Expected: only SELECT for authenticated on the 11 public tables. No rows
--     for anon. Nothing on private.dashboard_members.
select table_schema, table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where grantee in ('anon', 'authenticated', 'PUBLIC')
  and table_schema in ('public', 'private')
group by 1, 2, 3
order by 1, 2, 3;

-- Q4. Function EXECUTE privileges in public/private
--     Expected:
--       private.is_dashboard_member     -> authenticated (+ owner, service_role)
--       public.has_dashboard_access     -> authenticated (+ owner, service_role)
--       public.set_updated_at, public.enforce_order_status_transition,
--       public.is_valid_order_transition, private.guard_dashboard_members
--                                       -> NOT anon, NOT authenticated, NOT PUBLIC
--     security_definer = true ONLY for private.is_dashboard_member.
select n.nspname as schema, p.proname as function,
       p.prosecdef as security_definer,
       p.proconfig as settings,  -- expect {search_path=""}
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
       p.proacl as acl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'private')
order by 1, 2;

-- Q5. Schema access
--     Expected: anon has no USAGE on private; authenticated has USAGE on
--     private (needed for policy evaluation) but no CREATE anywhere.
select s.nspname as schema,
       has_schema_privilege('anon', s.oid, 'USAGE')           as anon_usage,
       has_schema_privilege('authenticated', s.oid, 'USAGE') as authenticated_usage,
       has_schema_privilege('anon', s.oid, 'CREATE')          as anon_create,
       has_schema_privilege('authenticated', s.oid, 'CREATE') as authenticated_create
from pg_namespace s
where s.nspname in ('public', 'private');

-- Q6. Sequence privileges for client roles
--     Expected: zero rows.
select sequence_schema, sequence_name, grantee, privilege_type
from information_schema.usage_privileges
where object_type = 'SEQUENCE' and grantee in ('anon', 'authenticated', 'PUBLIC')
  and sequence_schema in ('public', 'private');
-- (information_schema may omit some sequence grants, so also check directly)
select c.relname as sequence,
       has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE')          as anon_any,
       has_sequence_privilege('authenticated', c.oid, 'USAGE,SELECT,UPDATE') as authenticated_any
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'S' and n.nspname in ('public', 'private');

-- Q7. Default privileges for FUTURE objects created by postgres
--     Expected: no entries granting anon/authenticated anything in public or
--     private. (Entries owned by supabase_admin are Supabase-managed and only
--     apply to objects that role creates.)
select pg_get_userbyid(d.defaclrole) as creator,
       coalesce(n.nspname, '(all schemas)') as schema,
       case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences'
            when 'f' then 'functions' when 'T' then 'types' when 'n' then 'schemas' end as object_type,
       d.defaclacl as default_acl
from pg_default_acl d
left join pg_namespace n on n.oid = d.defaclnamespace
order by 1, 2, 3;

-- Q8. Realtime publication membership
--     Expected: none of the 11 business tables listed.
select pubname, schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime';

-- Q9. Views in public and whether they enforce the caller's RLS
--     Expected now: zero rows. Any future view must show security_invoker=true.
select c.relname as view_name, c.reloptions
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('v', 'm') and n.nspname = 'public';

-- Q10. Current dashboard members (run as postgres in the SQL Editor)
select m.user_id, u.email, m.role, m.is_active, m.approved_by, m.created_at
from private.dashboard_members m
join auth.users u on u.id = m.user_id
order by m.created_at;
