-- =============================================================================
-- QuickOps IQ · Remove ONLY the synthetic seed data  (DESTRUCTIVE)
-- =============================================================================
-- Deletes rows that carry the synthetic markers:
--   orders.order_number 'SYN-%', products.sku 'SYN-%',
--   dark_stores / riders names ending in '(synthetic)'
-- plus their dependent rows. The 5 seed cities are removed only if no other
-- store still references them. Rows without these markers are never touched.
--
-- One transaction: if any foreign key blocks a delete (e.g. a non-synthetic
-- row references synthetic data), everything rolls back and nothing changes.
-- Use this only when you intentionally want to regenerate the seed.
-- =============================================================================
begin;

delete from public.refunds r
  using public.orders o where o.id = r.order_id and o.order_number like 'SYN-%';
delete from public.delivery_events d
  using public.orders o where o.id = d.order_id and o.order_number like 'SYN-%';
delete from public.order_status_events e
  using public.orders o where o.id = e.order_id and o.order_number like 'SYN-%';
delete from public.inventory_events e
  using public.dark_stores s where s.id = e.store_id and s.name like '%(synthetic)';
delete from public.order_items i
  using public.orders o where o.id = i.order_id and o.order_number like 'SYN-%';
delete from public.orders where order_number like 'SYN-%';
delete from public.inventory i
  using public.dark_stores s where s.id = i.store_id and s.name like '%(synthetic)';
delete from public.riders where full_name like '%(synthetic)';
delete from public.products where sku like 'SYN-%';
delete from public.dark_stores where name like '%(synthetic)';
delete from public.cities c
  where c.code in ('BLR', 'MUM', 'DEL', 'HYD', 'PUN')
    and not exists (select 1 from public.dark_stores s where s.city_id = c.id);

commit;
