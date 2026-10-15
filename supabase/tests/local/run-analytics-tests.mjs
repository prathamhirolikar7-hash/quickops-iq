// Local, offline tests for migration 003 (analytics functions).
// In-memory PGlite (PostgreSQL 17, WebAssembly). Never connects to Supabase.
//
//   npm run test:analytics
//
// Steps: Supabase emulation -> 001 -> 002 -> 003 -> synthetic dataset (same
// generator + seed as the remote import) -> 003 test suite -> 002 security
// suite (regression) -> security spot checks -> per-function timings.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import { insertTable, TABLES } from "../../../scripts/seed/db-load.mjs"
import { generateDataset } from "../../../scripts/seed/generate.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const read = (p) => readFileSync(resolve(root, p), "utf8")
let failed = 0

const db = new PGlite()
const adapter = { query: async (sql, params) => (await db.query(sql, params)).rows }
const step = async (label, fn) => {
  const t0 = Date.now()
  try {
    await fn()
    console.log(`✔ ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  } catch (e) {
    console.error(`✘ ${label}\n  ${e.message}`)
    process.exit(1)
  }
}

await step("Supabase emulation", () => db.exec(read("supabase/tests/local/supabase-emulation.sql")))
await step("001_initial_schema.sql", () => db.exec(read("supabase/migrations/001_initial_schema.sql")))
await step("002_auth_and_rls.sql", () => db.exec(read("supabase/migrations/002_auth_and_rls.sql")))
await step("003_analytics_functions.sql", () => db.exec(read("supabase/migrations/003_analytics_functions.sql")))
await step("synthetic dataset (20,000 orders, same seed as remote)", async () => {
  const { tables } = generateDataset()
  for (const [t, cols] of TABLES) await insertTable(adapter, t, cols, tables[t])
  await db.exec("analyze")
})

// ---- 003 analytics test suite
const rows = (await db.exec(read("supabase/tests/003_analytics.test.sql"))).at(-1).rows
console.log("\nAnalytics tests (003_analytics.test.sql)")
let area = ""
for (const r of rows) {
  if (r.n === null) continue
  if (r.area !== area) console.log(`  [${(area = r.area)}]`)
  if (!r.pass) failed++
  console.log(`    ${r.pass ? "PASS" : "FAIL"}  ${r.test}${r.pass ? "" : `\n          expected=${r.expected}\n          actual  =${r.actual}`}`)
}
console.log(`  ${rows.find((r) => r.n === null).test}`)

// ---- 002 security suite must still pass with 003 installed
const sec = (await db.exec(read("supabase/tests/002_auth_and_rls.test.sql"))).at(-1).rows
const secSummary = sec.find((r) => r.n === null)
if (!secSummary.pass) failed++
console.log(`\nRegression: 002 permission tests → ${secSummary.test}`)

// ---- security spot checks for the new functions
console.log("\nSecurity spot checks")
const check = async (label, sql, ok) => {
  const res = (await db.query(sql)).rows
  const pass = ok(res)
  if (!pass) failed++
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${pass ? "" : `  -> ${JSON.stringify(res)}`}`)
}
const fns = `p.proname like 'analytics\\_%' and n.nspname = 'public'`
await check("11 analytics functions installed",
  `select count(*)::int c from pg_proc p join pg_namespace n on n.oid = p.pronamespace where ${fns}`, (r) => r[0].c === 11)
await check("all analytics functions are SECURITY INVOKER with search_path=''",
  `select bool_and(not p.prosecdef and p.proconfig @> array['search_path=""']) ok
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace where ${fns}`, (r) => r[0].ok === true)
await check("all analytics functions pinned to plan_cache_mode=force_custom_plan",
  `select bool_and(p.proconfig @> array['plan_cache_mode=force_custom_plan']) ok
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace where ${fns}`, (r) => r[0].ok === true)
await check("anon cannot EXECUTE any analytics function",
  `select bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) x from pg_proc p join pg_namespace n on n.oid = p.pronamespace where ${fns}`,
  (r) => r[0].x === false)
await check("authenticated can EXECUTE every analytics function",
  `select bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE')) x from pg_proc p join pg_namespace n on n.oid = p.pronamespace where ${fns}`,
  (r) => r[0].x === true)
await check("PUBLIC has no EXECUTE grant on analytics functions",
  `select count(*)::int c from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
     aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where ${fns} and a.grantee = 0`, (r) => r[0].c === 0)
await check("still exactly one SECURITY DEFINER function (private.is_dashboard_member)",
  `select array_agg(n.nspname || '.' || p.proname) f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.prosecdef`, (r) => JSON.stringify(r[0].f) === '["private.is_dashboard_member"]')
await check("RLS policies unchanged (11 read policies, no write policies)",
  `select count(*)::int c, bool_and(cmd = 'SELECT') s from pg_policies where schemaname in ('public','private')`,
  (r) => r[0].c === 11 && r[0].s)
await check("new indexes present",
  `select count(*)::int c from pg_indexes where indexname in
   ('orders_order_date_kpi_idx','inventory_events_stockout_time_idx','order_items_short_picked_idx')`, (r) => r[0].c === 3)

// ---- timings as an approved member (PGlite/WASM is slower than hosted Postgres)
// 8 calls per function in one session: past PL/pgSQL's 5-call threshold for
// switching to a generic plan (the regression this guards against).
const RUNS = 8
const MAX_MS = 3000
console.log(`\nTimings as an approved member (${RUNS} calls each in one session; local WASM Postgres)`)
const [{ lo, hi }] = (await db.query("select min(order_date)::text lo, max(order_date)::text hi from public.orders")).rows
const week = (await db.query(`select ($1::date - 6)::text d`, [hi])).rows[0].d
await db.exec(`begin;
  insert into auth.users (id, email) values ('00000000-0000-4000-8000-00000000c001', 'timing@example.invalid');
  insert into private.dashboard_members (user_id, approved_by) values ('00000000-0000-4000-8000-00000000c001', 'timing');
  select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000c001","role":"authenticated"}', true);
  set local role authenticated;`)
const calls = [
  ["analytics_overview (90 days)", `select * from public.analytics_overview('${lo}', '${hi}')`],
  ["analytics_overview (7 days)", `select * from public.analytics_overview('${week}', '${hi}')`],
  ["analytics_daily (90 days)", `select * from public.analytics_daily('${lo}', '${hi}')`],
  ["analytics_hourly (90 days)", `select * from public.analytics_hourly('${lo}', '${hi}')`],
  ["analytics_city_performance", `select * from public.analytics_city_performance('${lo}', '${hi}')`],
  ["analytics_store_performance", `select * from public.analytics_store_performance('${lo}', '${hi}')`],
  ["analytics_delivery_stages (hour)", `select * from public.analytics_delivery_stages('${lo}', '${hi}', p_group_by => 'hour')`],
  ["analytics_delivery_distribution", `select * from public.analytics_delivery_distribution('${lo}', '${hi}')`],
  ["analytics_inventory_status", `select * from public.analytics_inventory_status()`],
  ["analytics_stockouts", `select * from public.analytics_stockouts('${lo}', '${hi}')`],
  ["analytics_orders_page (page 1)", `select * from public.analytics_orders_page('${lo}', '${hi}')`],
  ["analytics_orders_page (search)", `select * from public.analytics_orders_page('${lo}', '${hi}', p_search => 'BLR-01')`],
]
for (const [label, sql] of calls) {
  const times = []
  let n = 0
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now()
    n = (await db.query(sql)).rows.length
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(RUNS / 2)]
  const max = times[RUNS - 1]
  const slow = max > MAX_MS
  if (slow) failed++
  console.log(`  ${slow ? "SLOW" : "ok  "} ${label.padEnd(36)} median ${median.toFixed(0).padStart(5)} ms · max ${max.toFixed(0).padStart(5)} ms  (${n} rows)`)
}
await db.exec("rollback")

console.log(failed === 0 ? "\nALL ANALYTICS TESTS PASSED" : `\n${failed} ANALYTICS TEST(S) FAILED`)
process.exit(failed ? 1 : 0)
