// Shared bulk-insert helpers for the synthetic seed (used by the seed CLI and
// the local test runners). Works with any adapter exposing query(sql, params).

// Insert order respects every foreign key. Generated columns are omitted.
export const TABLES = [
  ["cities", ["id uuid", "code text", "name text", "state text", "timezone text", "is_active boolean", "created_at timestamptz", "updated_at timestamptz"]],
  ["dark_stores", ["id uuid", "city_id uuid", "code text", "name text", "locality text", "latitude numeric", "longitude numeric", "status text", "sla_minutes smallint", "opened_on date", "created_at timestamptz", "updated_at timestamptz"]],
  ["products", ["id uuid", "sku text", "name text", "category text", "subcategory text", "brand text", "unit_label text", "mrp_paise bigint", "selling_price_paise bigint", "is_active boolean", "created_at timestamptz", "updated_at timestamptz"]],
  ["inventory", ["id uuid", "store_id uuid", "product_id uuid", "quantity_on_hand integer", "reorder_level integer", "last_restocked_at timestamptz", "created_at timestamptz", "updated_at timestamptz"]],
  ["riders", ["id uuid", "store_id uuid", "full_name text", "employment_type text", "vehicle_type text", "status text", "joined_on date", "created_at timestamptz", "updated_at timestamptz"]],
  ["orders", ["id uuid", "order_number text", "store_id uuid", "city_id uuid", "rider_id uuid", "status text", "payment_method text", "item_total_paise bigint", "discount_paise bigint", "delivery_fee_paise bigint", "placed_at timestamptz", "sla_deadline_at timestamptz", "delivered_at timestamptz", "cancelled_at timestamptz", "cancellation_reason text", "created_at timestamptz", "updated_at timestamptz"]],
  ["order_items", ["id uuid", "order_id uuid", "product_id uuid", "quantity integer", "quantity_fulfilled integer", "unit_mrp_paise bigint", "unit_price_paise bigint", "created_at timestamptz"]],
  ["inventory_events", ["store_id uuid", "product_id uuid", "event_type text", "quantity_change integer", "quantity_after integer", "order_id uuid", "occurred_at timestamptz", "created_at timestamptz"]],
  ["order_status_events", ["order_id uuid", "from_status text", "to_status text", "actor text", "occurred_at timestamptz", "created_at timestamptz"]],
  ["delivery_events", ["order_id uuid", "rider_id uuid", "event_type text", "occurred_at timestamptz", "created_at timestamptz"]],
  ["refunds", ["id uuid", "order_id uuid", "amount_paise bigint", "reason text", "status text", "initiated_at timestamptz", "processed_at timestamptz", "created_at timestamptz", "updated_at timestamptz"]],
]

const BATCH = 2000

/** Batched insert via jsonb_to_recordset, preserving row order (_n) */
export async function insertTable(db, table, columns, rows) {
  const names = columns.map((c) => c.split(" ")[0])
  const sql = `insert into public.${table} (${names.join(", ")})
    select ${names.map((n) => `x.${n}`).join(", ")}
    from jsonb_to_recordset($1::jsonb) as x(${columns.join(", ")}, _n integer)
    order by x._n`
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map((r, k) => ({ ...r, _n: i + k }))
    await db.query(sql, [JSON.stringify(batch)])
  }
}
