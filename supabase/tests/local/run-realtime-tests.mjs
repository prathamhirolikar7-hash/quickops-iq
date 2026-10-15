// Local, offline tests for migration 004 (Realtime analytics signals).
// In-memory PGlite with a minimal emulation of Supabase's realtime schema.
//
//   npm run test:realtime
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import { insertTable, TABLES } from "../../../scripts/seed/db-load.mjs"
import { generateDataset } from "../../../scripts/seed/generate.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const read = (p) => readFileSync(resolve(root, p), "utf8")
const MIGRATIONS = ["001_initial_schema.sql", "002_auth_and_rls.sql", "003_analytics_functions.sql", "004_realtime_signals.sql"]
let failed = 0
const report = (ok, label, detail = "") => {
  if (!ok) failed++
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `  -> ${detail}`}`)
}

const db = new PGlite()
await db.exec(read("supabase/tests/local/supabase-emulation.sql"))
for (const m of MIGRATIONS) {
  await db.exec(read(`supabase/migrations/${m}`))
  console.log(`✔ ${m}`)
}
const { tables } = generateDataset()
const adapter = { query: async (s, p) => (await db.query(s, p)).rows }
for (const [t, cols] of TABLES) await insertTable(adapter, t, cols, tables[t])
console.log("✔ synthetic dataset loaded (20,000 orders)")

// ---- 004 suite (same file as for the Supabase SQL Editor)
console.log("\nRealtime signal tests (004_realtime.test.sql)")
const rows = (await db.exec(read("supabase/tests/004_realtime.test.sql"))).at(-1).rows
for (const r of rows.filter((x) => x.n !== null)) report(r.pass, `[${r.area}] ${r.test}`, `expected=${r.expected} actual=${r.actual}`)
console.log(`  ${rows.find((r) => r.n === null).test}`)

// ---- local-only checks
console.log("\nLocal-only checks")
// The seed load above went through the triggers: statement-level => few signals
const [{ n: seeded }] = (await db.query(`select count(*)::int n from realtime.messages where topic = 'quickops:analytics'`)).rows
report(seeded > 0 && seeded <= 20, `bulk load of 20,000 orders + 2,481 refunds emitted only ${seeded} signals (one per batch statement)`)
await db.exec("begin")
await db.exec(`create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
  returns void language plpgsql as $$ begin raise exception 'realtime down (simulated)'; end $$`)
let writeOk = false
try {
  await db.exec("update public.orders set status = status where false; delete from public.refunds where false;")
  writeOk = true
} catch (e) {
  writeOk = false
  console.log(`    ${e.message}`)
}
await db.exec("rollback")
report(writeOk, "a failing broadcast never blocks the business write (warning only)")

const bare = new PGlite()
await bare.exec(read("supabase/tests/local/supabase-emulation.sql"))
await bare.exec("drop schema realtime cascade")
for (const m of MIGRATIONS.slice(0, 3)) await bare.exec(read(`supabase/migrations/${m}`))
let guarded = false
try {
  await bare.exec(read("supabase/migrations/004_realtime_signals.sql"))
} catch (e) {
  guarded = /Supabase Realtime is not available/.test(e.message)
  await bare.exec("rollback") // the migration's own transaction was aborted by the guard
}
const [{ n: trig }] = (await bare.query(`select count(*)::int n from pg_trigger where tgname like '%analytics_signal'`)).rows
report(guarded && trig === 0, "without Realtime, 004 refuses to install and leaves nothing behind")

// ---- regressions with 004 installed
console.log("\nRegressions with 004 installed")
const sec = (await db.exec(read("supabase/tests/002_auth_and_rls.test.sql"))).at(-1).rows.find((r) => r.n === null)
report(sec.pass, `002 permission tests: ${sec.test}`)
const ana = (await db.exec(read("supabase/tests/003_analytics.test.sql"))).at(-1).rows.find((r) => r.n === null)
report(ana.pass, `003 analytics tests: ${ana.test}`)
const [{ f }] = (await db.query(`select array_agg(n.nspname || '.' || p.proname) f from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private') and p.prosecdef`)).rows
report(JSON.stringify(f) === '["private.is_dashboard_member"]', "still exactly one SECURITY DEFINER function")

console.log(failed === 0 ? "\nALL REALTIME TESTS PASSED" : `\n${failed} REALTIME TEST(S) FAILED`)
process.exit(failed ? 1 : 0)
