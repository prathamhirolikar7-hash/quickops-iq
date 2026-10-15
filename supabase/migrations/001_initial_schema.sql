-- =============================================================================
-- QuickOps IQ · Migration 001 · Initial schema
-- =============================================================================
-- Operational database for a FICTIONAL Indian quick-commerce company.
--
-- Conventions
--   * Tables: snake_case, plural. Columns: snake_case.
--   * Entity tables use UUID primary keys (gen_random_uuid(), built into PG 13+).
--   * Append-only, high-volume event logs use BIGINT identity keys.
--   * Money is stored as BIGINT paise (₹1 = 100 paise) in columns ending _paise.
--     Never floating point.
--   * Every timestamp is TIMESTAMPTZ (stored in UTC). Business dates are IST.
--   * Statuses are TEXT plus a CHECK constraint, which is simpler to evolve
--     than enum types.
--
-- Metric definitions this schema supports
--   Order volume      count(orders) by orders.order_date / store / city
--   GMV               sum(orders.item_total_paise) for non-cancelled orders
--   AOV               GMV / number of non-cancelled orders
--   Delivery time     orders.delivery_seconds (placed -> delivered)
--   SLA compliance    share of delivered orders where orders.sla_met = true
--   Cancellation rate cancelled orders / all orders
--   Stockouts         inventory.quantity_on_hand = 0 (current)
--                     inventory_events.quantity_after = 0 (historical)
--                     order_items.quantity_fulfilled < quantity (lost demand)
--
-- Security: RLS is enabled on every table and NO policies are created here, so
-- the anon and authenticated roles can read or write nothing until policies are
-- added in a later migration. The service_role bypasses RLS.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------

-- Keeps updated_at current on every UPDATE
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Order lifecycle. Allowed transitions:
--   (new)            -> placed
--   placed           -> confirmed | cancelled
--   confirmed        -> picking   | cancelled
--   picking          -> packed    | cancelled
--   packed           -> out_for_delivery | cancelled
--   out_for_delivery -> delivered | cancelled   (failed delivery)
--   delivered, cancelled are terminal
create or replace function public.is_valid_order_transition(from_status text, to_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when from_status is null then to_status = 'placed'
    when from_status = 'placed'           then to_status in ('confirmed', 'cancelled')
    when from_status = 'confirmed'        then to_status in ('picking', 'cancelled')
    when from_status = 'picking'          then to_status in ('packed', 'cancelled')
    when from_status = 'packed'           then to_status in ('out_for_delivery', 'cancelled')
    when from_status = 'out_for_delivery' then to_status in ('delivered', 'cancelled')
    else false
  end;
$$;

-- -----------------------------------------------------------------------------
-- 1. cities
-- -----------------------------------------------------------------------------
create table public.cities (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z]{3}$'),   -- e.g. BLR
  name        text not null unique check (length(btrim(name)) > 0),
  state       text not null check (length(btrim(state)) > 0),
  timezone    text not null default 'Asia/Kolkata',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 2. dark_stores
-- -----------------------------------------------------------------------------
create table public.dark_stores (
  id           uuid primary key default gen_random_uuid(),
  city_id      uuid not null references public.cities (id) on delete restrict,
  code         text not null unique check (code ~ '^[A-Z]{3}-[0-9]{2,3}$'), -- e.g. BLR-01
  name         text not null check (length(btrim(name)) > 0),
  locality     text not null check (length(btrim(locality)) > 0),
  latitude     numeric(9, 6) check (latitude between -90 and 90),
  longitude    numeric(9, 6) check (longitude between -180 and 180),
  status       text not null default 'live'
               check (status in ('planned', 'live', 'paused', 'closed')),
  sla_minutes  smallint not null default 10 check (sla_minutes between 1 and 120),
  opened_on    date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Target for the composite FK on orders (keeps orders.city_id consistent)
  unique (id, city_id)
);

create index dark_stores_city_id_idx on public.dark_stores (city_id);

-- -----------------------------------------------------------------------------
-- 3. products
-- -----------------------------------------------------------------------------
create table public.products (
  id                   uuid primary key default gen_random_uuid(),
  sku                  text not null unique check (length(btrim(sku)) > 0),
  name                 text not null check (length(btrim(name)) > 0),
  category             text not null check (length(btrim(category)) > 0),
  subcategory          text,
  brand                text,
  unit_label           text not null check (length(btrim(unit_label)) > 0), -- e.g. "500 g"
  mrp_paise            bigint not null check (mrp_paise >= 0),
  selling_price_paise  bigint not null check (selling_price_paise >= 0),
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint products_price_within_mrp check (selling_price_paise <= mrp_paise)
);

create index products_category_idx on public.products (category);

-- -----------------------------------------------------------------------------
-- 4. inventory (current stock, one row per store + product)
-- -----------------------------------------------------------------------------
create table public.inventory (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references public.dark_stores (id) on delete restrict,
  product_id         uuid not null references public.products (id) on delete restrict,
  quantity_on_hand   integer not null default 0 check (quantity_on_hand >= 0),
  reorder_level      integer not null default 0 check (reorder_level >= 0),
  last_restocked_at  timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint inventory_store_product_key unique (store_id, product_id)
);

-- (store_id) lookups are served by the unique index above
create index inventory_product_id_idx on public.inventory (product_id);
-- Fast "what is out of stock right now" per store
create index inventory_stockouts_idx on public.inventory (store_id) where quantity_on_hand = 0;

-- -----------------------------------------------------------------------------
-- 5. riders
-- -----------------------------------------------------------------------------
create table public.riders (
  id               uuid primary key default gen_random_uuid(),
  store_id         uuid not null references public.dark_stores (id) on delete restrict, -- home store
  full_name        text not null check (length(btrim(full_name)) > 0),
  employment_type  text not null check (employment_type in ('full_time', 'part_time', 'gig')),
  vehicle_type     text not null check (vehicle_type in ('bicycle', 'e_bike', 'scooter', 'motorbike')),
  status           text not null default 'active' check (status in ('active', 'on_leave', 'inactive')),
  joined_on        date not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index riders_store_id_idx on public.riders (store_id);

-- -----------------------------------------------------------------------------
-- 6. orders
-- -----------------------------------------------------------------------------
-- city_id is copied from the store so the global city filter avoids a join.
-- The composite FK (store_id, city_id) -> dark_stores (id, city_id) guarantees
-- it can never disagree with the store's real city.
create table public.orders (
  id                   uuid primary key default gen_random_uuid(),
  order_number         text not null unique check (length(btrim(order_number)) > 0),
  store_id             uuid not null,
  city_id              uuid not null references public.cities (id) on delete restrict,
  rider_id             uuid references public.riders (id) on delete set null,
  status               text not null default 'placed'
                       check (status in ('placed', 'confirmed', 'picking', 'packed',
                                         'out_for_delivery', 'delivered', 'cancelled')),
  payment_method       text not null check (payment_method in ('upi', 'card', 'wallet', 'cod')),

  -- Money (paise). total_paise is derived, so it can never drift.
  item_total_paise     bigint not null check (item_total_paise >= 0),   -- GMV basis
  discount_paise       bigint not null default 0 check (discount_paise >= 0),
  delivery_fee_paise   bigint not null default 0 check (delivery_fee_paise >= 0),
  total_paise          bigint generated always as
                         (item_total_paise - discount_paise + delivery_fee_paise) stored,

  -- Key lifecycle timestamps (the detailed timeline lives in delivery_events)
  placed_at            timestamptz not null default now(),
  sla_deadline_at      timestamptz not null,
  delivered_at         timestamptz,
  cancelled_at         timestamptz,
  cancellation_reason  text check (cancellation_reason in (
                         'customer_request', 'item_unavailable', 'payment_failed',
                         'rider_unavailable', 'address_issue', 'store_closed', 'other')),

  -- Derived reporting fields
  order_date           date generated always as ((placed_at at time zone 'Asia/Kolkata')::date) stored, -- IST business date
  delivery_seconds     integer generated always as
                         (extract(epoch from (delivered_at - placed_at))::integer) stored,
  sla_met              boolean generated always as (delivered_at <= sla_deadline_at) stored,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint orders_store_city_fkey foreign key (store_id, city_id)
    references public.dark_stores (id, city_id) on delete restrict,
  constraint orders_discount_within_items check (discount_paise <= item_total_paise),
  constraint orders_sla_after_placed check (sla_deadline_at > placed_at),
  constraint orders_delivered_after_placed check (delivered_at is null or delivered_at >= placed_at),
  constraint orders_cancelled_after_placed check (cancelled_at is null or cancelled_at >= placed_at),
  -- delivered_at is set exactly when status = delivered
  constraint orders_delivered_state check ((status = 'delivered') = (delivered_at is not null)),
  -- cancelled_at and a reason are set exactly when status = cancelled
  constraint orders_cancelled_state check (
    (status = 'cancelled') = (cancelled_at is not null)
    and (status = 'cancelled') = (cancellation_reason is not null)
  ),
  -- A rider must be assigned once the order leaves the store
  constraint orders_rider_when_dispatched check (
    status not in ('out_for_delivery', 'delivered') or rider_id is not null
  )
);

-- Global filters: date alone, city + date, store + date
create index orders_placed_at_idx       on public.orders (placed_at desc);
create index orders_order_date_idx      on public.orders (order_date);
create index orders_city_date_idx       on public.orders (city_id, order_date);
create index orders_store_date_idx      on public.orders (store_id, order_date);
create index orders_status_date_idx     on public.orders (status, order_date);
create index orders_rider_id_idx        on public.orders (rider_id) where rider_id is not null;
-- Live operations board: only orders still in progress
create index orders_open_idx            on public.orders (store_id, placed_at)
  where status not in ('delivered', 'cancelled');

-- Reject illegal status changes made directly on orders
create or replace function public.enforce_order_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status
     and not public.is_valid_order_transition(old.status, new.status) then
    raise exception 'Invalid order status transition: % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger orders_status_transition
  before update of status on public.orders
  for each row execute function public.enforce_order_status_transition();

-- -----------------------------------------------------------------------------
-- 7. order_items
-- -----------------------------------------------------------------------------
create table public.order_items (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references public.orders (id) on delete cascade,
  product_id          uuid not null references public.products (id) on delete restrict,
  quantity            integer not null check (quantity > 0),
  -- Units actually packed; less than quantity means a stockout or substitution gap
  quantity_fulfilled  integer not null check (quantity_fulfilled >= 0),
  unit_mrp_paise      bigint not null check (unit_mrp_paise >= 0),
  unit_price_paise    bigint not null check (unit_price_paise >= 0),
  line_total_paise    bigint generated always as (quantity * unit_price_paise) stored,
  created_at          timestamptz not null default now(),
  constraint order_items_fulfilled_within_quantity check (quantity_fulfilled <= quantity),
  constraint order_items_price_within_mrp check (unit_price_paise <= unit_mrp_paise),
  constraint order_items_order_product_key unique (order_id, product_id)
);

-- (order_id) lookups are served by the unique index above
create index order_items_product_id_idx on public.order_items (product_id);

-- -----------------------------------------------------------------------------
-- 8. inventory_events (append-only stock ledger)
-- -----------------------------------------------------------------------------
create table public.inventory_events (
  id               bigint generated always as identity primary key,
  store_id         uuid not null,
  product_id       uuid not null,
  event_type       text not null check (event_type in (
                     'restock', 'sale', 'customer_return', 'damage', 'expiry',
                     'adjustment', 'transfer_in', 'transfer_out')),
  quantity_change  integer not null check (quantity_change <> 0),
  quantity_after   integer not null check (quantity_after >= 0),  -- 0 marks a stockout
  order_id         uuid references public.orders (id) on delete set null,
  occurred_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  -- Every movement must belong to an existing inventory row
  constraint inventory_events_inventory_fkey foreign key (store_id, product_id)
    references public.inventory (store_id, product_id) on delete restrict,
  -- Direction of the movement must match its type
  constraint inventory_events_direction check (
    case
      when event_type in ('restock', 'customer_return', 'transfer_in') then quantity_change > 0
      when event_type in ('sale', 'damage', 'expiry', 'transfer_out') then quantity_change < 0
      else true  -- adjustment can go either way
    end
  ),
  constraint inventory_events_sale_has_order check (event_type <> 'sale' or order_id is not null)
);

create index inventory_events_store_product_time_idx
  on public.inventory_events (store_id, product_id, occurred_at);
create index inventory_events_store_time_idx on public.inventory_events (store_id, occurred_at);
create index inventory_events_product_id_idx on public.inventory_events (product_id);
create index inventory_events_order_id_idx   on public.inventory_events (order_id) where order_id is not null;
create index inventory_events_stockouts_idx  on public.inventory_events (store_id, occurred_at)
  where quantity_after = 0;

-- -----------------------------------------------------------------------------
-- 9. order_status_events (audit trail of status changes)
-- -----------------------------------------------------------------------------
create table public.order_status_events (
  id           bigint generated always as identity primary key,
  order_id     uuid not null references public.orders (id) on delete cascade,
  from_status  text check (from_status in ('placed', 'confirmed', 'picking', 'packed',
                                          'out_for_delivery', 'delivered', 'cancelled')),
  to_status    text not null check (to_status in ('placed', 'confirmed', 'picking', 'packed',
                                                 'out_for_delivery', 'delivered', 'cancelled')),
  actor        text not null check (actor in ('customer', 'store', 'rider', 'system')),
  occurred_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  constraint order_status_events_valid_transition
    check (public.is_valid_order_transition(from_status, to_status)),
  -- An order reaches each status at most once
  constraint order_status_events_order_status_key unique (order_id, to_status)
);

create index order_status_events_order_time_idx on public.order_status_events (order_id, occurred_at);
create index order_status_events_status_time_idx on public.order_status_events (to_status, occurred_at);

-- -----------------------------------------------------------------------------
-- 10. delivery_events (fulfilment timeline: pick -> pack -> dispatch -> deliver)
-- -----------------------------------------------------------------------------
create table public.delivery_events (
  id           bigint generated always as identity primary key,
  order_id     uuid not null references public.orders (id) on delete cascade,
  rider_id     uuid references public.riders (id) on delete set null,
  event_type   text not null check (event_type in (
                 'picking_started', 'picking_completed', 'packing_completed',
                 'rider_assigned', 'dispatched', 'arrived_at_customer',
                 'delivered', 'delivery_failed')),
  occurred_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  -- Each milestone happens at most once per order
  constraint delivery_events_order_event_key unique (order_id, event_type)
);

-- (order_id) lookups are served by the unique index above
create index delivery_events_rider_time_idx on public.delivery_events (rider_id, occurred_at)
  where rider_id is not null;
create index delivery_events_type_time_idx on public.delivery_events (event_type, occurred_at);

-- -----------------------------------------------------------------------------
-- 11. refunds
-- -----------------------------------------------------------------------------
create table public.refunds (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders (id) on delete restrict,
  amount_paise  bigint not null check (amount_paise > 0),
  reason        text not null check (reason in (
                  'order_cancelled', 'item_missing', 'item_damaged',
                  'quality_issue', 'late_delivery', 'other')),
  status        text not null default 'initiated'
                check (status in ('initiated', 'processed', 'failed')),
  initiated_at  timestamptz not null default now(),
  processed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint refunds_processed_after_initiated
    check (processed_at is null or processed_at >= initiated_at),
  constraint refunds_processed_state check ((status = 'processed') = (processed_at is not null))
);

create index refunds_order_id_idx     on public.refunds (order_id);
create index refunds_initiated_at_idx on public.refunds (initiated_at);

-- -----------------------------------------------------------------------------
-- updated_at triggers
-- -----------------------------------------------------------------------------
create trigger cities_set_updated_at      before update on public.cities      for each row execute function public.set_updated_at();
create trigger dark_stores_set_updated_at before update on public.dark_stores for each row execute function public.set_updated_at();
create trigger products_set_updated_at    before update on public.products    for each row execute function public.set_updated_at();
create trigger inventory_set_updated_at   before update on public.inventory   for each row execute function public.set_updated_at();
create trigger riders_set_updated_at      before update on public.riders      for each row execute function public.set_updated_at();
create trigger orders_set_updated_at      before update on public.orders      for each row execute function public.set_updated_at();
create trigger refunds_set_updated_at     before update on public.refunds     for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row Level Security: enabled everywhere, no policies yet (deny by default)
-- -----------------------------------------------------------------------------
alter table public.cities              enable row level security;
alter table public.dark_stores         enable row level security;
alter table public.products            enable row level security;
alter table public.inventory           enable row level security;
alter table public.inventory_events    enable row level security;
alter table public.riders              enable row level security;
alter table public.orders              enable row level security;
alter table public.order_items         enable row level security;
alter table public.order_status_events enable row level security;
alter table public.delivery_events     enable row level security;
alter table public.refunds             enable row level security;

commit;
