-- =============================================================================
-- QuickOps IQ · Migration 005 · Demo order simulator (operator-only writes)
-- =============================================================================
-- Adds the first browser-triggered write path, deliberately narrow:
--
--   * New allowlist role 'operator' (private.dashboard_members.role).
--     'viewer' stays read-only. Only active operators may simulate.
--   * Writes happen ONLY inside SECURITY DEFINER functions in the private
--     schema (owned by postgres). They check operator status with auth.uid()
--     (never current_user, which is the owner inside a definer function),
--     use a fixed empty search_path, schema-qualified names, an advisory lock,
--     a global rate limit and hard caps.
--   * The browser calls thin SECURITY INVOKER wrappers in public
--     (simulator_tick / simulator_status / simulator_reset). Client roles still
--     have NO table write grants and NO write policies on business tables.
--   * Simulated orders are labelled 'SIM-NNNNNN'. Every stock movement they
--     cause is recorded in private.sim_inventory_events, so simulator_reset()
--     removes exactly the simulated data and restores inventory, leaving the
--     20,000 'SYN-' seed orders untouched.
--   * Orders progress through the real lifecycle (status transitions are still
--     enforced by the 001 trigger). Writes fire the 004 Realtime signals, so
--     dashboards update live.
--
-- Does NOT change: business tables/columns, business-table RLS policies or
-- grants, the supabase_realtime publication, or any 001-004 function.
--
-- Run once in the Supabase SQL Editor (as postgres). Atomic: begin ... commit.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. 'operator' role on the dashboard allowlist
-- -----------------------------------------------------------------------------
do $$
declare
  c text;
begin
  -- Drop the inline CHECK on role (auto-named) by locating it, not guessing
  for c in
    select conname from pg_constraint
    where conrelid = 'private.dashboard_members'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%role%'
  loop
    execute format('alter table private.dashboard_members drop constraint %I', c);
  end loop;
end;
$$;

alter table private.dashboard_members
  add constraint dashboard_members_role_check check (role in ('viewer', 'operator'));

create or replace function private.is_dashboard_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.dashboard_members m
    where m.user_id = (select auth.uid()) and m.is_active and m.role = 'operator'
  );
$$;

revoke all on function private.is_dashboard_operator() from public, anon;
grant execute on function private.is_dashboard_operator() to authenticated;

-- Which role does the signed-in user have? ('operator' | 'viewer' | null)
-- UX only: the simulator functions re-check operator status themselves.
create or replace function public.my_dashboard_role()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when private.is_dashboard_operator() then 'operator'
    when private.is_dashboard_member() then 'viewer'
  end;
$$;

revoke all on function public.my_dashboard_role() from public, anon;
grant execute on function public.my_dashboard_role() to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Private simulator state (not exposed; RLS on, no policies, no grants)
-- -----------------------------------------------------------------------------
create sequence private.sim_order_number_seq;

create table private.sim_state (
  id            boolean primary key default true check (id),
  last_tick_at  timestamptz,
  total_created bigint not null default 0
);
insert into private.sim_state default values;

-- Planned timeline for each simulated order (executed by simulator ticks)
create table private.sim_order_plan (
  order_id        uuid primary key references public.orders (id) on delete cascade,
  scenario        text not null check (scenario in ('normal', 'peak', 'rain', 'stockout')),
  confirm_at      timestamptz not null,
  pick_start_at   timestamptz not null,
  pick_done_at    timestamptz not null,
  pack_done_at    timestamptz not null,
  rider_assign_at timestamptz not null,
  dispatch_at     timestamptz not null,
  arrive_at       timestamptz not null,
  finish_at       timestamptz not null,
  rider_id        uuid not null references public.riders (id),
  cancel_stage    text check (cancel_stage in ('placed', 'out_for_delivery')),
  cancel_at       timestamptz,
  created_by      uuid not null,
  created_at      timestamptz not null default now(),
  constraint sim_order_plan_cancel_pair check ((cancel_stage is null) = (cancel_at is null))
);

-- Every inventory ledger row the simulator writes (for an exact reset)
create table private.sim_inventory_events (
  event_id bigint primary key references public.inventory_events (id) on delete cascade
);

alter table private.sim_state            enable row level security;
alter table private.sim_order_plan       enable row level security;
alter table private.sim_inventory_events enable row level security;
revoke all on table private.sim_state, private.sim_order_plan, private.sim_inventory_events
  from public, anon, authenticated;
revoke all on sequence private.sim_order_number_seq from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Internal helpers (plain functions; only callable by the owner, i.e. from
--    the definer entry points below)
-- -----------------------------------------------------------------------------
create or replace function private.sim_assert_operator()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not coalesce(private.is_dashboard_operator(), false) then
    raise exception 'QuickOps IQ operator access required'
      using errcode = '42501', hint = 'Only allowlisted operators can run the demo simulator.';
  end if;
end;
$$;

-- Ledger write: one inventory event + inventory update + tracking row.
-- Uses clock_timestamp() so each SKU's ledger stays in chronological order.
create or replace function private.sim_stock_move(
  p_store uuid, p_product uuid, p_type text, p_change int, p_order uuid
)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_after int;
  v_event bigint;
  v_now timestamptz := clock_timestamp();
begin
  update public.inventory
     set quantity_on_hand = quantity_on_hand + p_change,
         last_restocked_at = case when p_type = 'restock' then v_now else last_restocked_at end
   where store_id = p_store and product_id = p_product
  returning quantity_on_hand into v_after;
  insert into public.inventory_events (store_id, product_id, event_type, quantity_change, quantity_after, order_id, occurred_at, created_at)
  values (p_store, p_product, p_type, p_change, v_after, p_order, v_now, v_now)
  returning id into v_event;
  insert into private.sim_inventory_events (event_id) values (v_event);
  return v_after;
end;
$$;

create or replace function private.sim_refund(p_order uuid, p_amount bigint, p_reason text, p_at timestamptz)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_remaining bigint;
begin
  select o.total_paise - coalesce((select sum(r.amount_paise) from public.refunds r
                                   where r.order_id = o.id and r.status <> 'failed'), 0)
    into v_remaining
  from public.orders o where o.id = p_order;
  if least(p_amount, v_remaining) > 0 then
    insert into public.refunds (order_id, amount_paise, reason, status, initiated_at, created_at, updated_at)
    values (p_order, least(p_amount, v_remaining), p_reason, 'initiated', p_at, p_at, p_at);
  end if;
end;
$$;

create or replace function private.sim_create_order(p_scenario text, p_by uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_store record;
  v_rider uuid;
  v_order uuid;
  v_number text;
  v_payment text;
  v_placed timestamptz := clock_timestamp();
  v_lines int;
  v_item_total bigint;
  v_discount bigint := 0;
  v_fee bigint;
  v_r double precision := random();
  -- scenario knobs
  v_queue int := case p_scenario when 'peak' then 30 + (random() * 90)::int else 0 end;
  v_wait  int := case p_scenario when 'peak' then 30 + (random() * 150)::int else 0 end;
  v_speed double precision := 27.0 * (0.85 + random() * 0.3)
                              / case p_scenario when 'rain' then 1.4 when 'peak' then 1.25 else 1.1 end;
  v_km double precision := 0.4 + 2.2 * power(random(), 1.4);
  t_confirm timestamptz; t_pick timestamptz; t_picked timestamptz; t_packed timestamptz;
  t_assign timestamptz; t_dispatch timestamptz; t_arrive timestamptz; t_finish timestamptz;
  v_cancel_stage text;
  v_cancel_at timestamptz;
begin
  -- A live store with active riders and stock records
  select s.id, s.city_id, s.sla_minutes into v_store
  from public.dark_stores s
  where s.status = 'live'
    and exists (select 1 from public.riders r where r.store_id = s.id and r.status = 'active')
    and exists (select 1 from public.inventory i where i.store_id = s.id)
  order by random() limit 1;
  if v_store.id is null then
    raise exception 'no live store with riders and inventory is available for simulation';
  end if;
  select r.id into v_rider from public.riders r
  where r.store_id = v_store.id and r.status = 'active' order by random() limit 1;

  v_payment := case when v_r < 0.62 then 'upi' when v_r < 0.76 then 'card' when v_r < 0.84 then 'wallet' else 'cod' end;
  v_number := 'SIM-' || lpad(nextval('private.sim_order_number_seq')::text, 6, '0');
  v_lines := case p_scenario when 'stockout' then 2 + (random() * 4)::int else 1 + (random() * 4)::int end;

  insert into public.orders (order_number, store_id, city_id, payment_method, item_total_paise,
                             discount_paise, delivery_fee_paise, placed_at, sla_deadline_at, created_at)
  values (v_number, v_store.id, v_store.city_id, v_payment, 0, 0, 0, v_placed,
          v_placed + make_interval(mins => v_store.sla_minutes), v_placed)
  returning id into v_order;

  insert into public.order_items (order_id, product_id, quantity, quantity_fulfilled, unit_mrp_paise, unit_price_paise, created_at)
  select v_order, p.id,
         case p_scenario when 'stockout' then 2 + (random() * 2)::int
              else case when random() < 0.75 then 1 when random() < 0.85 then 2 else 3 end end,
         0, p.mrp_paise, p.selling_price_paise, v_placed
  from public.inventory i join public.products p on p.id = i.product_id
  where i.store_id = v_store.id and p.is_active
  order by random() limit v_lines;

  select coalesce(sum(line_total_paise), 0) into v_item_total from public.order_items where order_id = v_order;
  if v_item_total >= 19900 and random() < 0.22 then
    v_discount := least(10000, round(v_item_total * (0.05 + random() * 0.10) / 100) * 100);
  end if;
  v_fee := case when v_item_total < 19900 then 2500 else 0 end;
  update public.orders set item_total_paise = v_item_total, discount_paise = v_discount, delivery_fee_paise = v_fee
  where id = v_order;

  insert into public.order_status_events (order_id, from_status, to_status, actor, occurred_at, created_at)
  values (v_order, null, 'placed', 'customer', v_placed, v_placed);

  -- Planned timeline (seconds), same shape as the seed generator
  t_confirm  := v_placed   + make_interval(secs => 3 + random() * 17);
  t_pick     := t_confirm  + make_interval(secs => 5 + random() * 25 + v_queue);
  t_picked   := t_pick     + make_interval(secs => v_lines * (12 + random() * 8) + 10 + random() * 30);
  t_packed   := t_picked   + make_interval(secs => 20 + random() * 30);
  t_dispatch := t_packed   + make_interval(secs => 10 + random() * 30 + v_wait);
  t_assign   := greatest(t_pick + interval '20 seconds', t_dispatch - interval '30 seconds');
  t_arrive   := t_dispatch + make_interval(secs => v_km / v_speed * 3600 + 15 + random() * 45);
  t_finish   := t_arrive   + make_interval(secs => 20 + random() * 70);

  -- Planned non-stock cancellations (stock-driven ones are decided at picking)
  if random() < 0.02 then
    v_cancel_stage := 'placed';
    v_cancel_at := v_placed + make_interval(secs => 1 + random() * 2);  -- before confirmation
  elsif random() < 0.005 then
    v_cancel_stage := 'out_for_delivery';
    v_cancel_at := t_arrive + make_interval(secs => 180 + random() * 300);
  end if;

  insert into private.sim_order_plan (order_id, scenario, confirm_at, pick_start_at, pick_done_at, pack_done_at,
                                      rider_assign_at, dispatch_at, arrive_at, finish_at, rider_id,
                                      cancel_stage, cancel_at, created_by)
  values (v_order, p_scenario, t_confirm, t_pick, t_picked, t_packed, t_assign, t_dispatch, t_arrive, t_finish,
          v_rider, v_cancel_stage, v_cancel_at, p_by);
  return v_order;
end;
$$;

create or replace function private.sim_cancel(p_order uuid, p_reason text, p_actor text, p_at timestamptz)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_from text;
  v_payment text;
  v_total bigint;
begin
  select status, payment_method, total_paise into v_from, v_payment, v_total from public.orders where id = p_order;
  update public.orders set status = 'cancelled', cancelled_at = p_at, cancellation_reason = p_reason where id = p_order;
  insert into public.order_status_events (order_id, from_status, to_status, actor, occurred_at, created_at)
  values (p_order, v_from, 'cancelled', p_actor, p_at, p_at);
  if v_payment <> 'cod' then
    perform private.sim_refund(p_order, v_total, 'order_cancelled', p_at + interval '1 second');
  end if;
end;
$$;

-- Execute every stage of one order whose planned time has passed.
-- Returns the number of lifecycle steps applied.
create or replace function private.sim_advance(p_order uuid, p_now timestamptz)
returns int
language plpgsql
set search_path = ''
as $$
declare
  o record;
  pl record;
  l record;
  v_steps int := 0;
  v_fulfilled int;
  v_total_fulfilled int;
  v_short bigint;
  v_after int;
  v_reorder int;
begin
  select * into pl from private.sim_order_plan where order_id = p_order;
  loop
    select id, status, store_id, payment_method, placed_at, sla_deadline_at into o from public.orders where id = p_order;

    if o.status = 'placed' then
      if pl.cancel_stage = 'placed' and pl.cancel_at <= p_now then
        perform private.sim_cancel(p_order, 'customer_request', 'customer', pl.cancel_at);
      elsif pl.confirm_at <= p_now and pl.cancel_stage is distinct from 'placed' then
        update public.orders set status = 'confirmed' where id = p_order;
        insert into public.order_status_events (order_id, from_status, to_status, actor, occurred_at, created_at)
        values (p_order, 'placed', 'confirmed', 'system', pl.confirm_at, pl.confirm_at);
      else
        exit;
      end if;

    elsif o.status = 'confirmed' then
      exit when pl.pick_start_at > p_now;
      update public.orders set status = 'picking' where id = p_order;
      insert into public.order_status_events (order_id, from_status, to_status, actor, occurred_at, created_at)
      values (p_order, 'confirmed', 'picking', 'store', pl.pick_start_at, pl.pick_start_at);
      insert into public.delivery_events (order_id, event_type, occurred_at, created_at)
      values (p_order, 'picking_started', pl.pick_start_at, pl.pick_start_at);

    elsif o.status = 'picking' then
      if not exists (select 1 from public.delivery_events
                     where order_id = p_order and event_type = 'picking_completed') then
        exit when pl.pick_done_at > p_now;
        -- Pick from real stock: short lines are partially fulfilled
        v_total_fulfilled := 0;
        for l in
          select i.id, i.product_id, i.quantity, inv.quantity_on_hand, inv.reorder_level
          from public.order_items i
          join public.inventory inv on inv.store_id = o.store_id and inv.product_id = i.product_id
          where i.order_id = p_order
          order by i.product_id
          for update of inv
        loop
          v_fulfilled := least(l.quantity, l.quantity_on_hand);
          update public.order_items set quantity_fulfilled = v_fulfilled where id = l.id;
          v_total_fulfilled := v_total_fulfilled + v_fulfilled;
          if v_fulfilled > 0 then
            v_after := private.sim_stock_move(o.store_id, l.product_id, 'sale', -v_fulfilled, p_order);
            -- Replenish low stock, except in the stockout scenario
            if pl.scenario <> 'stockout' and v_after <= l.reorder_level and random() < 0.5 then
              v_reorder := greatest(l.reorder_level * 3, 4) - v_after;
              perform private.sim_stock_move(o.store_id, l.product_id, 'restock', v_reorder, null);
            end if;
          end if;
        end loop;
        insert into public.delivery_events (order_id, event_type, occurred_at, created_at)
        values (p_order, 'picking_completed', pl.pick_done_at, pl.pick_done_at);
        if v_total_fulfilled = 0 then
          perform private.sim_cancel(p_order, 'item_unavailable', 'store', pl.pick_done_at + interval '30 seconds');
        end if;
      else
        exit when pl.pack_done_at > p_now;
        update public.orders set status = 'packed' where id = p_order;
        insert into public.order_status_events (order_id, from_status, to_status, actor, occurred_at, created_at)
        values (p_order, 'picking', 'packed', 'store', pl.pack_done_at, pl.pack_done_at);
        insert into public.delivery_events (order_id, event_type, occurred_at, created_at)
        values (p_order, 'packing_completed', pl.pack_done_at, pl.pack_done_at);
      end if;

    elsif o.status = 'packed' then
      exit when pl.dispatch_at > p_now;
      update public.orders set status = 'out_for_delivery', rider_id = pl.rider_id where id = p_order;
      insert into public.order_status_events (order_id, from_status, to_status, actor, occurred_at, created_at)
      values (p_order, 'packed', 'out_for_delivery', 'rider', pl.dispatch_at, pl.dispatch_at);
      insert into public.delivery_events (order_id, rider_id, event_type, occurred_at, created_at) values
        (p_order, pl.rider_id, 'rider_assigned', pl.rider_assign_at, pl.rider_assign_at),
        (p_order, pl.rider_id, 'dispatched', pl.dispatch_at, pl.dispatch_at);

    elsif o.status = 'out_for_delivery' then
      if not exists (select 1 from public.delivery_events
                     where order_id = p_order and event_type = 'arrived_at_customer') then
        exit when pl.arrive_at > p_now;
        insert into public.delivery_events (order_id, rider_id, event_type, occurred_at, created_at)
        values (p_order, pl.rider_id, 'arrived_at_customer', pl.arrive_at, pl.arrive_at);
      elsif pl.cancel_stage = 'out_for_delivery' then
        exit when pl.cancel_at > p_now;
        insert into public.delivery_events (order_id, rider_id, event_type, occurred_at, created_at)
        values (p_order, pl.rider_id, 'delivery_failed', pl.cancel_at, pl.cancel_at);
        perform private.sim_cancel(p_order, 'address_issue', 'rider', pl.cancel_at);
        -- Goods come back to the shelf
        for l in select product_id, quantity_fulfilled from public.order_items
                 where order_id = p_order and quantity_fulfilled > 0 order by product_id loop
          perform private.sim_stock_move(o.store_id, l.product_id, 'customer_return', l.quantity_fulfilled, p_order);
        end loop;
      else
        exit when pl.finish_at > p_now;
        update public.orders set status = 'delivered', delivered_at = pl.finish_at where id = p_order;
        insert into public.order_status_events (order_id, from_status, to_status, actor, occurred_at, created_at)
        values (p_order, 'out_for_delivery', 'delivered', 'rider', pl.finish_at, pl.finish_at);
        insert into public.delivery_events (order_id, rider_id, event_type, occurred_at, created_at)
        values (p_order, pl.rider_id, 'delivered', pl.finish_at, pl.finish_at);
        -- Refund items that could not be picked
        select coalesce(sum((quantity - quantity_fulfilled) * unit_price_paise), 0) into v_short
        from public.order_items where order_id = p_order;
        if v_short > 0 then
          perform private.sim_refund(p_order, v_short, 'item_missing', pl.finish_at + interval '1 second');
        end if;
        -- Goodwill credit for some late deliveries
        if pl.finish_at > o.sla_deadline_at and random() < 0.2 then
          perform private.sim_refund(p_order, case when pl.finish_at - o.sla_deadline_at > interval '5 minutes'
                                                   then 5000 else 2500 end,
                                     'late_delivery', pl.finish_at + interval '2 seconds');
        end if;
      end if;

    else
      exit; -- delivered or cancelled: nothing left to do
    end if;
    v_steps := v_steps + 1;
  end loop;
  return v_steps;
end;
$$;

revoke all on function private.sim_assert_operator()                                   from public, anon, authenticated;
revoke all on function private.sim_stock_move(uuid, uuid, text, int, uuid)               from public, anon, authenticated;
revoke all on function private.sim_refund(uuid, bigint, text, timestamptz)               from public, anon, authenticated;
revoke all on function private.sim_create_order(text, uuid)                              from public, anon, authenticated;
revoke all on function private.sim_cancel(uuid, text, text, timestamptz)                 from public, anon, authenticated;
revoke all on function private.sim_advance(uuid, timestamptz)                            from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Definer entry points (operator check first, then lock, limits, work)
-- -----------------------------------------------------------------------------
create or replace function private.sim_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform private.sim_assert_operator();
  select jsonb_build_object(
    'total_orders',     count(*),
    'open_orders',      count(*) filter (where o.status not in ('delivered', 'cancelled')),
    'delivered_orders', count(*) filter (where o.status = 'delivered'),
    'cancelled_orders', count(*) filter (where o.status = 'cancelled'),
    'created_today',    count(*) filter (where o.order_date = (now() at time zone 'Asia/Kolkata')::date),
    'last_tick_at',     (select last_tick_at from private.sim_state),
    'max_open_orders',  500,
    'max_total_orders', 20000
  ) into v
  from public.orders o where o.order_number like 'SIM-%';
  return v;
end;
$$;

create or replace function private.sim_tick(p_scenario text, p_new_orders int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_last timestamptz;
  v_open int;
  v_total int;
  v_allowed int;
  v_created int := 0;
  v_steps int := 0;
  v_oid uuid;
  v_uid uuid := (select auth.uid());
begin
  perform private.sim_assert_operator();
  if p_scenario is null or p_scenario not in ('normal', 'peak', 'rain', 'stockout') then
    raise exception 'scenario must be normal, peak, rain or stockout' using errcode = '22023';
  end if;
  if p_new_orders is null or p_new_orders < 0 or p_new_orders > 25 then
    raise exception 'p_new_orders must be between 0 and 25' using errcode = '22023';
  end if;

  -- One simulator tick at a time across all operators
  perform pg_advisory_xact_lock(hashtext('quickops-iq-simulator'));
  select last_tick_at into v_last from private.sim_state for update;
  if v_last is not null and v_last > clock_timestamp() - interval '2 seconds' then
    raise exception 'simulator is rate limited: one tick per 2 seconds' using errcode = 'QO429';
  end if;

  -- Hard caps keep the demo bounded
  select count(*) filter (where status not in ('delivered', 'cancelled')), count(*)
    into v_open, v_total
  from public.orders where order_number like 'SIM-%';
  v_allowed := greatest(0, least(p_new_orders, 500 - v_open, 20000 - v_total));

  for i in 1 .. v_allowed loop
    perform private.sim_create_order(p_scenario, v_uid);
    v_created := v_created + 1;
  end loop;

  v_now := clock_timestamp();
  for v_oid in
    select o.id from public.orders o
    where o.order_number like 'SIM-%' and o.status not in ('delivered', 'cancelled')
    order by o.placed_at, o.id
  loop
    v_steps := v_steps + private.sim_advance(v_oid, v_now);
  end loop;

  update private.sim_state set last_tick_at = clock_timestamp(), total_created = total_created + v_created;

  return jsonb_build_object(
    'created', v_created,
    'requested', p_new_orders,
    'capped', v_created < p_new_orders,
    'steps_applied', v_steps,
    'scenario', p_scenario
  ) || private.sim_status();
end;
$$;

create or replace function private.sim_reset()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_orders int;
  v_events int;
  v_refunds int;
  v_touched text[];
begin
  perform private.sim_assert_operator();
  perform pg_advisory_xact_lock(hashtext('quickops-iq-simulator'));

  -- SKUs (store:product) whose ledger the simulator touched
  select coalesce(array_agg(distinct e.store_id::text || ':' || e.product_id::text), '{}')
    into v_touched
  from public.inventory_events e join private.sim_inventory_events s on s.event_id = e.id;

  delete from public.inventory_events e using private.sim_inventory_events s where s.event_id = e.id;
  get diagnostics v_events = row_count;
  delete from public.refunds r using public.orders o where o.id = r.order_id and o.order_number like 'SIM-%';
  get diagnostics v_refunds = row_count;
  -- order_items, status/delivery events and plans cascade with the order
  delete from public.orders where order_number like 'SIM-%';
  get diagnostics v_orders = row_count;

  -- Restore stock to the last remaining ledger balance
  update public.inventory i
     set quantity_on_hand = coalesce((select e.quantity_after from public.inventory_events e
                                      where e.store_id = i.store_id and e.product_id = i.product_id
                                      order by e.occurred_at desc, e.id desc limit 1), 0),
         last_restocked_at = (select max(e.occurred_at) from public.inventory_events e
                              where e.store_id = i.store_id and e.product_id = i.product_id and e.event_type = 'restock')
   where (i.store_id::text || ':' || i.product_id::text) = any (v_touched);

  update private.sim_state set total_created = 0;
  return jsonb_build_object('deleted_orders', v_orders, 'deleted_stock_events', v_events, 'deleted_refunds', v_refunds)
         || private.sim_status();
end;
$$;

revoke all on function private.sim_status()               from public, anon;
revoke all on function private.sim_tick(text, int)        from public, anon;
revoke all on function private.sim_reset()                from public, anon;
grant execute on function private.sim_status()            to authenticated;
grant execute on function private.sim_tick(text, int)     to authenticated;
grant execute on function private.sim_reset()             to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Public RPC wrappers (SECURITY INVOKER; the private functions check access)
-- -----------------------------------------------------------------------------
create or replace function public.simulator_status()
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.sim_status(); $$;

create or replace function public.simulator_tick(p_scenario text default 'normal', p_new_orders int default 3)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.sim_tick(p_scenario, p_new_orders); $$;

create or replace function public.simulator_reset()
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.sim_reset(); $$;

revoke all on function public.simulator_status()          from public, anon;
revoke all on function public.simulator_tick(text, int)   from public, anon;
revoke all on function public.simulator_reset()           from public, anon;
grant execute on function public.simulator_status()       to authenticated;
grant execute on function public.simulator_tick(text, int) to authenticated;
grant execute on function public.simulator_reset()        to authenticated;

commit;
