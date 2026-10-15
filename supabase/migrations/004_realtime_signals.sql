-- =============================================================================
-- QuickOps IQ · Migration 004 · Realtime "analytics changed" signals
-- =============================================================================
-- Purpose: let the dashboard refresh itself when orders or refunds change,
-- WITHOUT streaming business data over Realtime.
--
-- Design (why not postgres_changes on the business tables?)
--   * 002 deliberately keeps all 11 business tables out of the
--     supabase_realtime publication. This migration does NOT change that.
--   * Instead, a statement-level trigger sends a tiny broadcast on a PRIVATE
--     channel ("quickops:analytics"). Payload: table name, operation,
--     timestamp. No ids, amounts, names or any other row data.
--   * Receiving it requires a SELECT policy on realtime.messages, granted
--     here ONLY to approved dashboard members (private.is_dashboard_member()).
--   * No INSERT policy is added, so browsers cannot send (spoof) signals.
--   * On a signal, the dashboard re-runs the existing analytics functions,
--     which still enforce RLS + the membership check.
--
-- What it adds
--   1. private.broadcast_analytics_change(): SECURITY INVOKER trigger function
--   2. Statement-level AFTER triggers on public.orders and public.refunds
--      (one signal per statement, not per row, so bulk loads cannot flood)
--   3. One read policy on realtime.messages for the private topic
--
-- What it does NOT change: business tables, columns, existing RLS policies,
-- grants, the supabase_realtime publication, or any 001-003 function.
--
-- Failure isolation: if a broadcast fails (e.g. Realtime unavailable or the
-- writing role cannot call realtime.send), the business write still commits
-- and a WARNING is logged; dashboards fall back to periodic refresh.
--
-- Run once in the Supabase SQL Editor (as postgres). Atomic: begin ... commit.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0. Preconditions: Supabase Realtime database objects must exist
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('realtime.messages') is null then
    raise exception 'realtime.messages not found: Supabase Realtime is not available in this database';
  end if;
  if to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then
    raise exception 'realtime.send(jsonb, text, text, boolean) not found: Realtime Broadcast from Database is not available';
  end if;
  if to_regprocedure('realtime.topic()') is null then
    raise exception 'realtime.topic() not found: Realtime Authorization is not available';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 1. Signal function (statement-level trigger)
-- -----------------------------------------------------------------------------
create or replace function private.broadcast_analytics_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  begin
    perform realtime.send(
      jsonb_build_object(
        'v', 1,
        'table', tg_table_name,
        'op', lower(tg_op),
        'at', now()
      ),
      'analytics_changed',   -- event
      'quickops:analytics',  -- topic
      true                   -- private channel: requires an authorization policy
    );
  exception when others then
    -- Never block a business write because the notification failed
    raise warning 'quickops: realtime analytics signal not sent (%): %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

-- Trigger functions are never called directly; no client role may execute it
revoke all on function private.broadcast_analytics_change() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Statement-level triggers (one signal per statement)
-- -----------------------------------------------------------------------------
create trigger orders_analytics_signal
  after insert or update or delete or truncate on public.orders
  for each statement execute function private.broadcast_analytics_change();

create trigger refunds_analytics_signal
  after insert or update or delete or truncate on public.refunds
  for each statement execute function private.broadcast_analytics_change();

-- -----------------------------------------------------------------------------
-- 3. Who may RECEIVE signals on the private topic: approved members only
-- -----------------------------------------------------------------------------
-- Realtime checks this policy when a client joins the private channel (with
-- realtime.topic() set to the channel name) and re-checks on token refresh.
create policy quickops_analytics_signal_receive on realtime.messages
  for select
  to authenticated
  using (
    (select realtime.topic()) = 'quickops:analytics'
    and realtime.messages.extension = 'broadcast'
    and (select private.is_dashboard_member())
  );
-- Deliberately NO insert/update/delete policy: clients cannot send signals.

commit;
