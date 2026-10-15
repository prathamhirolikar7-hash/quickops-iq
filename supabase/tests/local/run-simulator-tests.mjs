// Local, offline tests for migration 005 (demo order simulator).
//   npm run test:simulator
// Emulation -> 001..005 -> synthetic dataset -> 005 suite -> committed
// simulator run + full seed validator + exact reset -> 002/003/004 regressions.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import { insertTable, TABLES } from "../../../scripts/seed/db-load.mjs"
import { generateDataset } from "../../../scripts/seed/generate.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const read = (p) => readFileSync(resolve(root, p), "utf8")
const MIGRATIONS = ["001_initial_schema", "002_auth_and_rls", "003_analytics_functions", "004_realtime_signals", "005_order_simulator"]
let failed = 0
const report = (ok, label, detail = "") => {
  if (!ok) failed++
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `  -> ${detail}`}`)
}

const db = new PGlite()
await db.exec(read("supabase/tests/local/supabase-emulation.sql"))
for (const m of MIGRATIONS) {
  await db.exec(read(`supabase/migrations/${m}.sql`))
  console.log(`✔ ${m}.sql`)
}
const { tables } = generateDataset()
for (const [t, cols] of TABLES) await insertTable({ query: async (s, p) => (await db.query(s, p)).rows }, t, cols, tables[t])
console.log("✔ synthetic dataset loaded (20,000 orders)")

// ---- 005 suite (same file as for the Supabase SQL Editor)
console.log("\nSimulator tests (005_simulator.test.sql)")
const rows = (await db.exec(read("supabase/tests/005_simulator.test.sql"))).at(-1).rows
for (const r of rows.filter((x) => x.n !== null)) report(r.pass, `[${r.area}] ${r.test}`, `expected=${r.expected} actual=${r.actual}`)
console.log(`  ${rows.find((r) => r.n === null).test}`)

// ---- committed run across all scenarios, then the full seed validator, then reset
console.log("\nCommitted simulator run (local only)")
const OP = "00000000-0000-4000-8000-00000000e001"
await db.exec(`insert into auth.users (id, email) values ('${OP}', 'op@example.invalid');
  insert into private.dashboard_members (user_id, approved_by, role) values ('${OP}', 'local-test', 'operator');`)
const asOp = async (sql) => {
  await db.exec(`begin; select set_config('request.jwt.claims', '{"sub":"${OP}"}', true); set local role authenticated;`)
  try {
    const r = (await db.query(sql)).rows
    await db.exec("commit")
    return r
  } catch (e) {
    await db.exec("rollback")
    throw e
  }
}
const fingerprint = async () => (await db.query(`select md5(string_agg(h, '|' order by h)) h from (
  select 'o' || md5(string_agg(x::text, ',' order by id)) h from public.orders x union all
  select 'i' || md5(string_agg(x::text, ',' order by id)) from public.order_items x union all
  select 'e' || md5(string_agg(x::text, ',' order by id)) from public.inventory_events x union all
  select 'v' || md5(string_agg((x.id, x.quantity_on_hand, x.reorder_level, x.last_restocked_at)::text, ',' order by id)) from public.inventory x union all
  select 's' || md5(string_agg(x::text, ',' order by id)) from public.order_status_events x union all
  select 'd' || md5(string_agg(x::text, ',' order by id)) from public.delivery_events x union all
  select 'r' || md5(string_agg(x::text, ',' order by id)) from public.refunds x) z`)).rows[0].h
const before = await fingerprint()
let created = 0
for (const sc of ["normal", "peak", "rain", "stockout"]) {
  await db.exec("update private.sim_state set last_tick_at = null")
  created += (await asOp(`select public.simulator_tick('${sc}', 25) t`))[0].t.created
}
await db.exec(`update private.sim_order_plan set confirm_at = confirm_at - interval '1 hour', pick_start_at = pick_start_at - interval '1 hour',
  pick_done_at = pick_done_at - interval '1 hour', pack_done_at = pack_done_at - interval '1 hour', rider_assign_at = rider_assign_at - interval '1 hour',
  dispatch_at = dispatch_at - interval '1 hour', arrive_at = arrive_at - interval '1 hour', finish_at = finish_at - interval '1 hour', cancel_at = cancel_at - interval '1 hour';
  update public.orders set placed_at = placed_at - interval '1 hour', sla_deadline_at = sla_deadline_at - interval '1 hour', created_at = created_at - interval '1 hour' where order_number like 'SIM-%';
  update public.order_status_events set occurred_at = occurred_at - interval '1 hour' where to_status = 'placed' and order_id in (select id from public.orders where order_number like 'SIM-%');
  update private.sim_state set last_tick_at = null;`)
const done = (await asOp(`select public.simulator_tick('normal', 0) t`))[0].t
report(created === 100 && done.open_orders === 0, `100 orders across 4 scenarios completed their lifecycle (${done.delivered_orders} delivered, ${done.cancelled_orders} cancelled)`)
const bad = (await db.exec(read("supabase/seed/validate_seed.sql"))).at(-1).rows.filter((r) => Number(r.violations) > 0)
report(bad.length === 0, "all 27 seed data-quality checks still pass with simulated orders", bad.map((r) => `#${r.check_no}`).join(","))
const reset = (await asOp(`select public.simulator_reset() r`))[0].r
report(reset.deleted_orders === 100 && (await fingerprint()) === before,
  `reset removed ${reset.deleted_orders} orders / ${reset.deleted_stock_events} stock events / ${reset.deleted_refunds} refunds; seed data identical`)

// ---- regressions with 005 installed
console.log("\nRegressions with 005 installed")
for (const [file, label] of [["002_auth_and_rls", "002 permission tests"], ["003_analytics", "003 analytics tests"], ["004_realtime", "004 realtime tests"]]) {
  const s = (await db.exec(read(`supabase/tests/${file}.test.sql`))).at(-1).rows.find((r) => r.n === null)
  report(s.pass, `${label}: ${s.test}`)
}

console.log(failed === 0 ? "\nALL SIMULATOR TESTS PASSED" : `\n${failed} SIMULATOR TEST(S) FAILED`)
process.exit(failed ? 1 : 0)
