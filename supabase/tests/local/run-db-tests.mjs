// Local, offline database tests. Runs entirely in memory with PGlite
// (PostgreSQL compiled to WebAssembly). Never connects to Supabase.
//
//   npm run test:db
//
// Steps: Supabase emulation -> 001 -> (simulate a table in realtime) -> 002
//        -> permission test suite -> read-only verification spot checks.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "../../..")
const read = (p) => readFileSync(resolve(root, p), "utf8")

const db = new PGlite()
let failed = 0

async function step(label, sql) {
  try {
    await db.exec(sql)
    console.log(`✔ ${label}`)
  } catch (e) {
    console.error(`✘ ${label}\n  ${e.message}`)
    process.exit(1)
  }
}

console.log((await db.query("select version()")).rows[0].version, "\n")
await step("Supabase emulation (roles, auth schema, default grants)", read("supabase/tests/local/supabase-emulation.sql"))
await step("001_initial_schema.sql", read("supabase/migrations/001_initial_schema.sql"))
// Simulate someone having enabled realtime on a business table before 002
await step("simulate realtime on public.orders", "alter publication supabase_realtime add table public.orders")
await step("002_auth_and_rls.sql", read("supabase/migrations/002_auth_and_rls.sql"))
await step("003_analytics_functions.sql", read("supabase/migrations/003_analytics_functions.sql"))

// ---- Permission test suite (same file you run in the Supabase SQL Editor)
const results = await db.exec(read("supabase/tests/002_auth_and_rls.test.sql"))
const rows = results.at(-1).rows
console.log("\nPermission tests")
for (const r of rows) {
  if (r.n === null) continue
  const mark = r.pass ? "PASS" : "FAIL"
  if (!r.pass) failed++
  console.log(`  ${mark}  ${r.test.padEnd(52)} ${r.actor.padEnd(26)} expected=${r.expected.padEnd(9)} actual=${r.actual}`)
}
const summary = rows.find((r) => r.n === null)
console.log(`  ${summary.test}`)

// ---- Spot checks mirroring verify_security.sql
console.log("\nVerification spot checks")
const check = async (label, sql, predicate) => {
  const res = (await db.query(sql)).rows
  const ok = predicate(res)
  if (!ok) failed++
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  -> ${JSON.stringify(res)}`}`)
}
await check("RLS enabled on 11 public tables + allowlist",
  `select count(*)::int n from pg_class c join pg_namespace s on s.oid=c.relnamespace
   where c.relkind='r' and s.nspname in ('public','private') and c.relrowsecurity`, (r) => r[0].n === 12)
await check("exactly 11 policies, all SELECT-only for authenticated",
  `select count(*)::int n, bool_and(cmd='SELECT' and roles='{authenticated}') ok from pg_policies where schemaname in ('public','private')`,
  (r) => r[0].n === 11 && r[0].ok)
await check("anon holds no table privileges",
  `select count(*)::int n from information_schema.role_table_grants where grantee='anon' and table_schema in ('public','private')`, (r) => r[0].n === 0)
await check("authenticated holds only SELECT on public tables",
  `select array_agg(distinct privilege_type) p from information_schema.role_table_grants where grantee='authenticated' and table_schema in ('public','private')`,
  (r) => JSON.stringify(r[0].p) === '["SELECT"]')
await check("only private.is_dashboard_member is SECURITY DEFINER, with search_path=''",
  `select array_agg(n.nspname||'.'||p.proname) f, bool_and(p.proconfig @> array['search_path=""']) sp
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prosecdef`,
  (r) => JSON.stringify(r[0].f) === '["private.is_dashboard_member"]' && r[0].sp)
await check("internal 001 functions not executable by anon/authenticated",
  `select bool_or(has_function_privilege(r, p.oid, 'EXECUTE')) any_exec
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace, unnest(array['anon','authenticated']) r
   where n.nspname='public' and p.proname in ('set_updated_at','enforce_order_status_transition','is_valid_order_transition')`,
  (r) => r[0].any_exec === false)
await check("anon has no USAGE on private schema",
  `select has_schema_privilege('anon','private','USAGE') u`, (r) => r[0].u === false)
await check("no business table in supabase_realtime",
  `select count(*)::int n from pg_publication_tables where pubname='supabase_realtime'`, (r) => r[0].n === 0)
await check("no persisted test fixtures left behind",
  `select (select count(*) from public.orders)::int + (select count(*) from auth.users)::int
        + (select count(*) from private.dashboard_members)::int n`, (r) => r[0].n === 0)

console.log(failed === 0 ? "\nALL DATABASE TESTS PASSED" : `\n${failed} DATABASE TEST(S) FAILED`)
process.exit(failed ? 1 : 0)
