# QuickOps IQ · Synthetic seed data

All data produced here is **synthetic**. It describes a fictional quick-commerce
company. City names are real; every store, product brand, rider, price, order,
refund and stock movement is invented. Markers:

| Table | Marker |
|---|---|
| orders | `order_number` = `SYN-000001` … `SYN-020000` |
| products | `sku` starts with `SYN-`, brand ends with `(synthetic)` |
| dark_stores | name ends with `(synthetic)` |
| riders | name ends with `(synthetic)` |
| everything else | linked to the rows above |

## Files

| Path | Purpose |
|---|---|
| `scripts/seed/config.mjs` | Cities, stores, catalogue, demand curves, rates |
| `scripts/seed/generate.mjs` | Deterministic generator (pure function, no I/O) |
| `scripts/seed/seed.mjs` | Loader CLI: local PGlite or remote Postgres |
| `supabase/seed/validate_seed.sql` | 27 read-only data-quality checks (all must be 0) |
| `supabase/seed/seed_metrics.sql` | Read-only summary metrics (KPIs, city, hour, stock) |
| `supabase/seed/reset_synthetic_data.sql` | Deletes only synthetic rows (destructive) |

## What gets generated (defaults)

20,000 orders over 90 days (16 Jul – 13 Oct 2026, IST) across 5 cities and 16
live dark stores (plus 1 planned store with no data), 112 products in 12
categories, 113 riders. About 450k rows in total.

Realism built in: breakfast and evening peaks, weekend uplift, festival days,
monsoon rain days (slower riders and more orders), 15% growth over the quarter,
peak-hour traffic, rider availability, ~2.7% cancellations across five reasons,
partial fulfilment on stockouts with automatic item-missing refunds, goodwill
refunds, restocks, expiry and damage.

## 1 · Verify locally first (no network)

```bash
npm run seed:local
```

This creates an in-memory Postgres (PGlite), applies migrations 001 and 002,
then:
- generates the data twice and checks the SHA-256 is identical
- loads it in one transaction and runs `validate_seed.sql`
- reruns the load to prove nothing is duplicated
- runs `reset_synthetic_data.sql` and reloads
- prints headline metrics

## 2 · Import into Supabase (you run this, after approval)

The loader connects from **your machine** with the **database password**, as
the `postgres` role (the same role the SQL Editor uses). It does not use the
service-role API key, and nothing is exposed to the browser.

1. **Connection string.** In Supabase, click **Connect** → **Session pooler**
   (port 5432, works over IPv4). Copy the URI and fill in your database password.
   URL-encode special characters in the password (e.g. `@` → `%40`).
2. **Create `.env.seed.local`** in the project root. It is git-ignored via `*.local`:
   ```
   SEED_DATABASE_URL=postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres
   ```
   Do **not** prefix it with `VITE_`; Vite only exposes `VITE_*` variables to
   the browser bundle.
3. **TLS certificate (recommended).** In **Project Settings → Database → SSL
   Configuration**, download the CA certificate, e.g. to
   `supabase/seed/supabase-ca.crt`. This is a public certificate, not a secret.
4. **Run:**
   ```bash
   npm run seed:remote -- --confirm-remote --ca-cert supabase/seed/supabase-ca.crt
   ```
   Fallback, encrypted but without certificate verification:
   `--allow-unverified-tls`.
5. **Verify** in the SQL Editor: run `validate_seed.sql` (all zeros) and the
   queries in `seed_metrics.sql`.
6. **Optional:** delete `.env.seed.local` or rotate the database password
   afterwards.

### Safety guarantees of the loader
- **One transaction** plus an advisory lock: either everything is written or nothing.
- **Empty-table guard:** it only writes into empty business tables. If the
  identical seed is already there it prints "already seeded" and exits without
  changes. Any other existing data makes it abort without writing.
- **Validated before commit:** `validate_seed.sql` runs inside the transaction,
  and any violation rolls everything back.
- **Database rules stay on:** constraints, triggers and RLS remain enabled. No
  migration is changed.

### Regenerating
To replace the data (e.g. a new `--end-date`), run
`reset_synthetic_data.sql` in the SQL Editor first, then the loader again.

## Options

```
--seed <text>          default quickops-iq-synthetic-v1 (same seed = same data)
--orders <n>           default 20000
--days <n>             default 90
--end-date YYYY-MM-DD  last IST day included; must be before today
```
