#!/usr/bin/env node
// =============================================================================
// QuickOps IQ · Synthetic seed loader
// =============================================================================
// Server-side / CLI only. Never import this from React code.
//
//   npm run seed:local                       # default: in-memory PGlite, no network
//   npm run seed:preflight                   # READ-ONLY check of the remote target
//   npm run seed:remote -- --confirm-remote  # your Supabase project (see README)
//
// Options
//   --target local|remote   default local
//   --seed <text>           default quickops-iq-synthetic-v1
//   --orders <n>            default 20000
//   --days <n>              default 90
//   --end-date YYYY-MM-DD   last IST day included, default 2026-10-13
//   --confirm-remote        required for --target remote (not for --preflight)
//   --preflight             remote only: read-only connection + target checks,
//                           no data generated or written
//   --verify                remote only: read-only run of validate_seed.sql,
//                           headline metrics and row counts
//   --ca-cert <path>        Supabase CA certificate (verifies TLS)
//   --allow-unverified-tls  encrypt without verifying the server certificate
//   --skip-reset-test       local only: skip the reset + reload round trip
//
// Safety model
//   * Everything is loaded in ONE transaction, with an advisory lock.
//   * Guard: loads only into EMPTY business tables. If the identical seed is
//     already present it reports "already seeded" and changes nothing (rerun
//     safe). Anything else aborts without writing.
//   * validate_seed.sql runs inside the transaction; any violation rolls back.
//   * Constraints, triggers and RLS stay enabled. The loader connects as the
//     table owner (postgres), the same role as the SQL Editor.
// =============================================================================
import { createHash, X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { DEFAULTS } from "./config.mjs"
import { insertTable, TABLES } from "./db-load.mjs"
import { generateDataset } from "./generate.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const read = (p) => readFileSync(resolve(root, p), "utf8")

const { values: args } = parseArgs({
  options: {
    target: { type: "string", default: "local" },
    seed: { type: "string", default: DEFAULTS.seed },
    orders: { type: "string", default: String(DEFAULTS.orders) },
    days: { type: "string", default: String(DEFAULTS.days) },
    "end-date": { type: "string", default: DEFAULTS.endDate },
    "confirm-remote": { type: "boolean", default: false },
    preflight: { type: "boolean", default: false },
    verify: { type: "boolean", default: false },
    "ca-cert": { type: "string" },
    "allow-unverified-tls": { type: "boolean", default: false },
    "skip-reset-test": { type: "boolean", default: false },
  },
})


// ---------------------------------------------------------------------------
// Database adapters (same interface for PGlite and node-postgres)
// ---------------------------------------------------------------------------
async function openLocal() {
  const { PGlite } = await import("@electric-sql/pglite")
  const db = new PGlite()
  await db.exec(read("supabase/tests/local/supabase-emulation.sql"))
  await db.exec(read("supabase/migrations/001_initial_schema.sql"))
  await db.exec(read("supabase/migrations/002_auth_and_rls.sql"))
  return {
    label: "local PGlite (in-memory, 001 + 002 applied)",
    query: async (sql, params) => (await db.query(sql, params)).rows,
    exec: async (sql) => (await db.exec(sql)).map((r) => r.rows),
    close: () => db.close(),
  }
}

// Secrets that must never reach the console (filled once the URL is parsed)
const SECRETS = []
const redact = (text) => SECRETS.reduce((t, s) => (s ? t.split(s).join("[redacted]") : t), String(text))
const mask = (s) => (s.length <= 8 ? "****" : `${s.slice(0, 4)}…${s.slice(-2)}`)

function parseTarget() {
  const raw = process.env.SEED_DATABASE_URL
  if (!raw) fail("SEED_DATABASE_URL is not set. .env.seed.local must contain a line: SEED_DATABASE_URL=postgresql://...")
  let url
  try {
    url = new URL(raw)
  } catch {
    fail("SEED_DATABASE_URL is not a valid URL (value not shown). Check brackets, quotes and URL-encoding of the password.")
  }
  const user = decodeURIComponent(url.username)
  SECRETS.push(raw, url.password, decodeURIComponent(url.password), url.username, user, url.hostname)
  if (/^\[.*\]$/.test(decodeURIComponent(url.password)) || /^%5B.*%5D$/i.test(url.password))
    fail("The password in SEED_DATABASE_URL is wrapped in [square brackets] copied from Supabase's [YOUR-PASSWORD] placeholder. Remove the brackets (value not shown).")
  const ref = /^postgres\.([a-z0-9]+)$/.exec(user)?.[1] ?? /^db\.([a-z0-9]+)\.supabase\.co$/.exec(url.hostname)?.[1]
  const region = /^aws-\d+-([a-z0-9-]+)\.pooler\.supabase\.com$/.exec(url.hostname)?.[1]
  return {
    url,
    summary: {
      kind: /\.pooler\.supabase\.com$/.test(url.hostname) ? (url.port === "6543" ? "transaction pooler" : "session pooler") : "direct",
      project_ref: ref ? mask(ref) : "(not recognised)",
      region: region ?? "(n/a)",
      port: url.port || "5432",
      database: url.pathname.slice(1),
    },
  }
}

async function openRemote() {
  const { url, summary } = parseTarget()
  let ssl
  if (args["ca-cert"]) ssl = { ca: readFileSync(args["ca-cert"], "utf8"), rejectUnauthorized: true }
  else if (args["allow-unverified-tls"]) ssl = { rejectUnauthorized: false }
  else fail("Choose TLS mode: --ca-cert <path to Supabase CA .crt> (recommended) or --allow-unverified-tls.")
  url.searchParams.delete("sslmode") // TLS is configured explicitly above
  const { default: pg } = await import("pg")
  const client = new pg.Client({ connectionString: url.toString(), ssl, application_name: "quickops-iq-seed" })
  client.on("error", (e) => console.error(`connection error: ${redact(e.message)}`))
  try {
    await client.connect()
  } catch (e) {
    fail(`Could not connect: ${redact(e.message)}`)
  }
  const socket = client.connection?.stream
  return {
    label: `remote ${summary.kind} · project ${summary.project_ref} · ${summary.region} · db ${summary.database}`,
    summary,
    tls: socket?.encrypted
      ? {
        encrypted: true,
        certificate_verified: socket.authorized === true,
        protocol: socket.getProtocol?.(),
        issuer: socket.getPeerCertificate?.()?.issuer?.CN ?? null,
      }
      : { encrypted: false },
    query: async (sql, params) => (await client.query(sql, params)).rows,
    exec: async (sql) => {
      const res = await client.query(sql)
      return (Array.isArray(res) ? res : [res]).map((r) => r.rows)
    },
    close: () => client.end(),
  }
}

// ---------------------------------------------------------------------------
// Read-only preflight: who/where am I, is TLS verified, is the schema from
// 001 + 002 present, are the target tables empty? Writes nothing.
// ---------------------------------------------------------------------------
async function preflight() {
  if (args["ca-cert"]) {
    const cert = new X509Certificate(readFileSync(args["ca-cert"]))
    console.log(`CA certificate: subject "${cert.subject.replace(/\n/g, ", ")}", valid until ${cert.validTo}`)
  }
  const db = await openRemote()
  const out = { ok: [], problems: [] }
  const check = (cond, okMsg, badMsg) => (cond ? out.ok : out.problems).push(cond ? okMsg : badMsg)
  console.log(`→ target: ${db.label}`)
  console.log(`  TLS: ${JSON.stringify(db.tls)}`)
  try {
    await db.exec("begin transaction read only")
    await db.exec("set local statement_timeout = '30s'")
    const [who] = await db.query(`select current_database() as database, current_user as role,
        current_setting('server_version') as server_version,
        current_setting('transaction_read_only') as read_only_transaction`)
    console.log(`  session: ${JSON.stringify(who)}`)

    const names = TABLES.map(([t]) => t)
    const [schema] = await db.query(`select
        (select count(*) from pg_tables where schemaname = 'public' and tablename = any($1))::int as tables_found,
        (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = any($1) and c.relrowsecurity)::int as rls_enabled,
        (select count(*) from pg_policies where schemaname = 'public' and policyname = 'dashboard_members_read')::int as read_policies,
        to_regclass('private.dashboard_members') is not null as allowlist_table,
        to_regprocedure('private.is_dashboard_member()') is not null as membership_function`, [names])
    console.log(`  schema: ${JSON.stringify(schema)}`)
    let members = null
    if (schema.allowlist_table) [{ members }] = await db.query("select count(*)::int as members from private.dashboard_members")

    const [counts] = await db.query(`select ${names.map((t) => `(select count(*) from public.${t})::int as ${t}`).join(", ")}`)
    console.log("  row counts:", counts)
    await db.exec("rollback")

    check(db.tls.encrypted && db.tls.certificate_verified, "TLS encrypted and certificate verified",
      db.tls.encrypted ? "TLS encrypted but certificate NOT verified (use --ca-cert)" : "connection NOT encrypted")
    check(who.read_only_transaction === "on", "preflight ran in a read-only transaction", "transaction was not read-only")
    check(who.role === "postgres", "connected as postgres (table owner, same as SQL Editor)", `connected as ${who.role}, expected postgres`)
    check(schema.tables_found === 11, "all 11 business tables exist (001)", `${schema.tables_found}/11 business tables found`)
    check(schema.rls_enabled === 11, "RLS enabled on all 11 tables", `RLS enabled on ${schema.rls_enabled}/11`)
    check(schema.read_policies === 11 && schema.allowlist_table && schema.membership_function,
      `migration 002 present (11 read policies, allowlist, membership function; ${members} approved member(s))`,
      "migration 002 objects missing")
    const nonEmpty = Object.entries(counts).filter(([, n]) => n > 0)
    check(nonEmpty.length === 0, "all 11 target tables are empty: ready for import",
      `tables not empty: ${nonEmpty.map(([t, n]) => `${t}=${n}`).join(", ")}`)
  } catch (e) {
    try { await db.exec("rollback") } catch { /* ignore */ }
    await db.close()
    fail(`Preflight query failed: ${redact(e.message)}`)
  }
  await db.close()
  console.log("")
  for (const m of out.ok) console.log(`✔ ${m}`)
  for (const m of out.problems) console.log(`✘ ${m}`)
  console.log(out.problems.length ? "\nPREFLIGHT: NOT READY (nothing was written)" : "\nPREFLIGHT: READY (nothing was written)")
  process.exit(out.problems.length ? 1 : 0)
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
function expectedFingerprint(tables) {
  return {
    counts: Object.fromEntries(TABLES.map(([t]) => [t, tables[t].length])),
    item_total: tables.orders.reduce((a, o) => a + o.item_total_paise, 0),
    refund_total: tables.refunds.reduce((a, r) => a + r.amount_paise, 0),
  }
}

async function currentFingerprint(db) {
  const countsSql = TABLES.map(([t]) => `(select count(*) from public.${t})::int as ${t}`).join(", ")
  const [counts] = await db.query(`select ${countsSql}`)
  const [sums] = await db.query(`select
      (select coalesce(sum(item_total_paise), 0) from public.orders)::text as item_total,
      (select coalesce(sum(amount_paise), 0) from public.refunds)::text as refund_total,
      (select count(*) from public.orders where order_number like 'SYN-%')::int as syn_orders`)
  return { counts, item_total: Number(sums.item_total), refund_total: Number(sums.refund_total), syn_orders: sums.syn_orders }
}

async function seed(db, dataset) {
  const { tables } = dataset
  const want = expectedFingerprint(tables)
  await db.exec("begin")
  try {
    await db.exec("set local statement_timeout = '30min'; set local lock_timeout = '15s'")
    await db.query("select pg_advisory_xact_lock(hashtext('quickops-iq-synthetic-seed'))")

    const have = await currentFingerprint(db)
    const total = Object.values(have.counts).reduce((a, b) => a + b, 0)
    if (total > 0) {
      const same = TABLES.every(([t]) => have.counts[t] === want.counts[t])
        && have.item_total === want.item_total && have.refund_total === want.refund_total
        && have.syn_orders === want.counts.orders
      await db.exec("rollback")
      if (same) return { status: "already-seeded" }
      fail(`Business tables already contain data that does not match this seed (${JSON.stringify(have.counts)}).
  Nothing was changed. To replace synthetic data, run supabase/seed/reset_synthetic_data.sql first.`)
    }

    for (const [table, columns] of TABLES) {
      const t0 = Date.now()
      await insertTable(db, table, columns, tables[table])
      console.log(`    ${table.padEnd(20)} ${String(tables[table].length).padStart(7)} rows  ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    }

    const checks = (await db.exec(read("supabase/seed/validate_seed.sql"))).at(-1)
    const bad = checks.filter((c) => Number(c.violations) !== 0)
    if (bad.length) {
      await db.exec("rollback")
      for (const c of bad) console.error(`    FAIL #${c.check_no} ${c.check_name}: ${c.violations}`)
      fail("Validation failed; transaction rolled back, nothing was written.")
    }
    await db.exec("commit")
    return { status: "seeded", checks }
  } catch (e) {
    try { await db.exec("rollback") } catch { /* already closed */ }
    throw e
  }
}

function datasetHash(tables) {
  const h = createHash("sha256")
  for (const [t] of TABLES) for (const row of tables[t]) h.update(JSON.stringify(row))
  return h.digest("hex")
}

function fail(msg) {
  console.error(`\n✘ ${redact(msg)}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const options = { seed: args.seed, orders: Number(args.orders), days: Number(args.days), endDate: args["end-date"] }
if (!/^\d{4}-\d{2}-\d{2}$/.test(options.endDate)) fail("--end-date must be YYYY-MM-DD")
const todayIst = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
if (options.endDate >= todayIst) fail(`--end-date must be before today (IST ${todayIst}) so no data is in the future.`)
if (!["local", "remote"].includes(args.target)) fail("--target must be local or remote")
if (args.preflight) {
  if (args.target !== "remote") fail("--preflight requires --target remote")
  await preflight() // exits; never generates or writes data
}
if (args.verify) {
  if (args.target !== "remote") fail("--verify requires --target remote")
  const db = await openRemote()
  console.log(`→ target: ${db.label}`)
  console.log(`  TLS: ${JSON.stringify(db.tls)}`)
  let failed = 0
  try {
    await db.exec("begin transaction read only")
    await db.exec("set local statement_timeout = '5min'")
    const checks = (await db.exec(read("supabase/seed/validate_seed.sql"))).at(-1)
    console.log("\nData-quality checks (read-only):")
    for (const c of checks) {
      const ok = Number(c.violations) === 0
      if (!ok) failed++
      console.log(`  ${ok ? "PASS" : "FAIL"}  #${String(c.check_no).padStart(2)} ${c.check_name}${ok ? "" : ` (${c.violations} violations)`}`)
    }
    const metrics = await db.exec(read("supabase/seed/seed_metrics.sql"))
    console.log("\nHeadline metrics (M1):", metrics[0][0])
    console.log("Row counts (M9):", Object.fromEntries(metrics[8].map((r) => [r.table_name, Number(r.count)])))
    await db.exec("rollback")
  } catch (e) {
    try { await db.exec("rollback") } catch { /* ignore */ }
    await db.close()
    fail(`Verification query failed: ${redact(e.message)}`)
  }
  await db.close()
  console.log(failed ? `\nVERIFY: ${failed} check(s) FAILED` : "\nVERIFY: all data-quality checks passed (read-only)")
  process.exit(failed ? 1 : 0)
}
if (args.target === "remote" && !args["confirm-remote"]) fail("Refusing to write to a remote database without --confirm-remote.")
if (args.target === "remote" && !process.env.SEED_DATABASE_URL) fail("SEED_DATABASE_URL is not set. Put it in .env.seed.local (git-ignored). See supabase/seed/README.md.")

console.log(`QuickOps IQ synthetic seed · seed="${options.seed}" orders=${options.orders} days=${options.days} end=${options.endDate}`)
let t0 = Date.now()
const dataset = generateDataset(options)
const hash = datasetHash(dataset.tables)
console.log(`✔ generated in ${((Date.now() - t0) / 1000).toFixed(1)}s · window ${dataset.meta.windowStart} → ${dataset.meta.windowEnd}`)
console.log(`  dataset sha256 ${hash}`)

if (args.target === "local") {
  const again = datasetHash(generateDataset(options).tables)
  console.log(`${again === hash ? "✔" : "✘"} determinism: second generation ${again === hash ? "identical" : "DIFFERENT"}`)
  if (again !== hash) process.exit(1)
}

const db = args.target === "remote" ? await openRemote() : await openLocal()
console.log(`→ target: ${db.label}`)

t0 = Date.now()
const first = await seed(db, dataset)
if (first.status === "already-seeded") {
  console.log("✔ identical synthetic seed already present; nothing changed.")
} else {
  console.log(`✔ loaded and committed in ${((Date.now() - t0) / 1000).toFixed(1)}s; ${first.checks.length}/${first.checks.length} data-quality checks passed`)
}

if (args.target === "local") {
  const rerun = await seed(db, dataset)
  console.log(`${rerun.status === "already-seeded" ? "✔" : "✘"} rerun: ${rerun.status === "already-seeded" ? "detected existing seed, no duplicates written" : "UNEXPECTED second load"}`)

  if (!args["skip-reset-test"]) {
    await db.exec(read("supabase/seed/reset_synthetic_data.sql"))
    const after = await currentFingerprint(db)
    const empty = Object.values(after.counts).every((n) => n === 0)
    console.log(`${empty ? "✔" : "✘"} reset_synthetic_data.sql removed all synthetic rows`)
    const reload = await seed(db, dataset)
    console.log(`${reload.status === "seeded" ? "✔" : "✘"} reload after reset: ${reload.status}`)
  }

  const [m] = (await db.exec(read("supabase/seed/seed_metrics.sql")))[0]
  console.log("\nHeadline metrics (M1):", m)
  const cities = (await db.exec(read("supabase/seed/seed_metrics.sql")))[1]
  console.table(cities)
}

const [counts] = await db.query(`select ${TABLES.map(([t]) => `(select count(*) from public.${t})::int as ${t}`).join(", ")}`)
console.log("Row counts:", counts)
await db.close()
