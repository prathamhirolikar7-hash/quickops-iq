-- =============================================================================
-- QuickOps IQ · Migration 002 · Supabase Auth allowlist + read-only RLS
-- =============================================================================
-- Builds on 001_initial_schema.sql (already deployed). It does not alter any
-- table structure, constraint, index or trigger from 001.
--
-- Access model
--   * Identity: Supabase Auth (auth.users / auth.uid()).
--   * Authorisation: a database-managed allowlist, private.dashboard_members.
--     Signing up creates an auth.users row but grants NOTHING. Only a row in
--     the allowlist with is_active = true unlocks dashboard reads.
--   * The allowlist lives in the non-exposed "private" schema. The Data API
--     cannot reach it, anon/authenticated hold no privileges on it, and a guard
--     trigger rejects any write attempted as anon/authenticated. Members are
--     managed only from the SQL Editor (postgres role).
--   * Approved members: SELECT on the 11 business tables, filtered by RLS.
--   * Nobody using the anon or authenticated role can INSERT, UPDATE, DELETE
--     or TRUNCATE. Demo writes come in a later migration.
--   * service_role (server-side only, never in React) keeps its Supabase
--     defaults and bypasses RLS.
--
-- What 001 left open, and how this migration closes it
--   * Supabase's default privileges gave anon and authenticated ALL on every
--     new public table: SELECT/INSERT/UPDATE/DELETE plus TRUNCATE, REFERENCES
--     and TRIGGER. RLS does not apply to TRUNCATE, so those grants are revoked
--     here, not merely filtered by policies.
--   * The three 001 functions were EXECUTE-able by PUBLIC (callable as RPC).
--   * Future tables, views and functions in public would inherit the same
--     broad defaults. Those defaults are reset below.
--
-- Run once in the Supabase SQL Editor (as postgres). Atomic: begin ... commit.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Private schema (NOT listed under API > Exposed schemas)
-- -----------------------------------------------------------------------------
create schema if not exists private;

revoke all on schema private from public, anon;
-- authenticated needs USAGE only so that RLS policies (evaluated as the
-- querying role) can call private.is_dashboard_member(). Usage on a schema
-- grants nothing on the objects inside it.
grant usage on schema private to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Allowlist / membership table
-- -----------------------------------------------------------------------------
create table private.dashboard_members (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  role         text not null default 'viewer' check (role in ('viewer')),
  is_active    boolean not null default true,
  approved_by  text not null check (length(btrim(approved_by)) > 0),
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table private.dashboard_members is
  'Allowlist of Supabase Auth users who may read the QuickOps IQ dashboard. Managed only via SQL Editor.';

-- Defence in depth: RLS on with no policies, and no table privileges for
-- client roles.
alter table private.dashboard_members enable row level security;
revoke all on table private.dashboard_members from public, anon, authenticated;

create trigger dashboard_members_set_updated_at
  before update on private.dashboard_members
  for each row execute function public.set_updated_at();

-- Guard: even if privileges were ever granted by mistake, client roles cannot
-- write membership rows, and no signed-in user can approve themselves.
create or replace function private.guard_dashboard_members()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'dashboard membership can only be managed by an administrator'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and auth.uid() is not null and new.user_id = auth.uid() then
    raise exception 'users cannot approve or modify their own dashboard membership'
      using errcode = 'insufficient_privilege';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger dashboard_members_guard
  before insert or update or delete on private.dashboard_members
  for each row execute function private.guard_dashboard_members();

revoke all on function private.guard_dashboard_members() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Membership check used by every business-table policy
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER so it can read the allowlist the caller cannot see. It
-- reveals only one boolean about the caller themself.
--   * Fixed empty search_path; every reference is schema-qualified.
--   * Owned by postgres, the table owner, so it reads the allowlist without
--     any policy (no recursion: business policies -> this function -> a table
--     with no policies).
--   * EXECUTE granted to authenticated only.
create or replace function private.is_dashboard_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.dashboard_members m
    where m.user_id = (select auth.uid())
      and m.is_active
  );
$$;

revoke all on function private.is_dashboard_member() from public, anon;
grant execute on function private.is_dashboard_member() to authenticated;

-- UX helper for the frontend ("your account is awaiting approval"). It is
-- SECURITY INVOKER and returns only the caller's own status. It grants no
-- access: the policies are the real enforcement.
create or replace function public.has_dashboard_access()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.is_dashboard_member();
$$;

revoke all on function public.has_dashboard_access() from public, anon;
grant execute on function public.has_dashboard_access() to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Business tables: least-privilege grants
-- -----------------------------------------------------------------------------
-- Strip everything (incl. TRUNCATE, REFERENCES, TRIGGER) from client roles.
revoke all on table
  public.cities, public.dark_stores, public.products, public.inventory,
  public.inventory_events, public.riders, public.orders, public.order_items,
  public.order_status_events, public.delivery_events, public.refunds
from public, anon, authenticated;

-- Approved users read. Rows are still filtered by the RLS policies below.
grant select on table
  public.cities, public.dark_stores, public.products, public.inventory,
  public.inventory_events, public.riders, public.orders, public.order_items,
  public.order_status_events, public.delivery_events, public.refunds
to authenticated;

-- Identity sequences behind the three event tables
revoke all on all sequences in schema public from public, anon, authenticated;

-- 001 helper functions are internal (trigger and constraint helpers), not RPCs
revoke all on function public.set_updated_at()                        from public, anon, authenticated;
revoke all on function public.enforce_order_status_transition()        from public, anon, authenticated;
revoke all on function public.is_valid_order_transition(text, text)    from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. RLS policies: SELECT for approved members only
-- -----------------------------------------------------------------------------
-- No INSERT/UPDATE/DELETE policies exist, so writes are denied by RLS as well
-- as by the missing grants. (select ...) lets Postgres evaluate the check once
-- per statement instead of once per row.
create policy dashboard_members_read on public.cities              for select to authenticated using ((select private.is_dashboard_member()));
create policy dashboard_members_read on public.dark_stores         for select to authenticated using ((select private.is_dashboard_member()));
create policy dashboard_members_read on public.products            for select to authenticated using ((select private.is_dashboard_member()));
create policy dashboard_members_read on public.inventory           for select to authenticated using ((select private.is_dashboard_member()));
create policy dashboard_members_read on public.inventory_events    for select to authenticated using ((select private.is_dashboard_member()));
create policy dashboard_members_read on public.riders              for select to authenticated using ((select private.is_dashboard_member()));
create policy dashboard_members_read on public.orders              for select to authenticated using ((select private.is_dashboard_member()));
create policy dashboard_members_read on public.order_items         for select to authenticated using ((select private.is_dashboard_member()));
create policy dashboard_members_read on public.order_status_events for select to authenticated using ((select private.is_dashboard_member()));
create policy dashboard_members_read on public.delivery_events     for select to authenticated using ((select private.is_dashboard_member()));
create policy dashboard_members_read on public.refunds             for select to authenticated using ((select private.is_dashboard_member()));

-- -----------------------------------------------------------------------------
-- 6. Future objects must not silently become public
-- -----------------------------------------------------------------------------
-- Objects created later by postgres (SQL Editor / migrations) get NO privileges
-- for anon/authenticated until a migration grants them explicitly. Rules for
-- future work:
--   * Views:     create with (security_invoker = true) so the caller's RLS
--                applies, and grant select explicitly.
--   * Functions: default to SECURITY INVOKER. Any SECURITY DEFINER function
--                goes in private, uses set search_path = '', and gets
--                explicit, minimal EXECUTE grants.
alter default privileges for role postgres in schema public
  revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;
-- PUBLIC's built-in EXECUTE on functions can only be removed globally
alter default privileges for role postgres
  revoke execute on functions from public;
alter default privileges for role postgres in schema private
  revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema private
  revoke all on functions from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7. Realtime: business tables are not broadcast
-- -----------------------------------------------------------------------------
-- postgres_changes respects RLS, but nothing needs realtime yet. Make sure none
-- of the 11 tables is in the supabase_realtime publication. Re-add a table
-- deliberately in a later migration if needed.
do $$
declare
  t text;
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    for t in
      select format('%I.%I', schemaname, tablename)
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename in ('cities', 'dark_stores', 'products', 'inventory', 'inventory_events',
                          'riders', 'orders', 'order_items', 'order_status_events',
                          'delivery_events', 'refunds')
    loop
      execute format('alter publication supabase_realtime drop table %s', t);
    end loop;
  end if;
end;
$$;

commit;
