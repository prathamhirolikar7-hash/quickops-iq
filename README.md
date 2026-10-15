# QuickOps IQ

**Real-time operations analytics for quick-commerce.**
A full-stack dashboard that monitors order flow, revenue, delivery SLAs and inventory health
across a network of dark stores, with role-based access and live updates.

![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL%2017-3FCF8E?logo=supabase&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind%20CSS-4-06B6D4?logo=tailwindcss&logoColor=white)
![Built with Claude](https://img.shields.io/badge/Built%20with-Claude-D97757)

> **Data notice:** All business data in this project is synthetic. The company, dark stores,
> riders, products and the 20,000 orders are generated for demonstration; only city names are real.

---

## Overview

QuickOps IQ models the operations of an Indian quick-commerce business (10-minute grocery
delivery) operating 16 dark stores across Bengaluru, Mumbai, Delhi NCR, Hyderabad and Pune.
It answers the questions an operations or business-analytics team asks every day:

- How many orders are we fulfilling, and what is the revenue trend against the previous period?
- Which cities and stores are driving GMV, and where is performance slipping?
- Are deliveries meeting the 10-minute SLA, and which stage of fulfilment causes delays?
- Where are stockouts occurring, and what is the resulting lost revenue?

All aggregation runs server-side in PostgreSQL; the browser receives only computed results.

## Key features

| Area | Capability |
|---|---|
| **Executive Overview** | Six KPIs (Total Orders, GMV, AOV, Avg Delivery Time, On-time Delivery %, Cancellation Rate) with previous-period deltas and daily sparklines |
| **Trend & breakdown analytics** | Order-volume trend vs prior period, GMV by city or store, hour-of-day demand, delivery-time distribution against SLA, store leaderboard |
| **Global filtering** | City, store and date-range filters (Today, Yesterday, Last 7/30 days, MTD) applied consistently across all views, using IST business dates |
| **Orders Explorer** | Server-side search, status filtering, multi-column sorting and stable pagination over the full order history |
| **Real-time updates** | Private Realtime channel signals data changes; dashboards refresh automatically with debounce, throttling, reconnect backoff and polling fallback |
| **Order Simulator** | Operator-only tool that generates orders progressing through the full lifecycle (placed → picking → packed → out for delivery → delivered/cancelled) across four scenarios, with an exact, isolated reset |
| **Access control** | Supabase Auth with a database-managed allowlist and viewer/operator roles |

## Architecture

```
┌────────────────────────────── Browser ──────────────────────────────┐
│ React 19 · TanStack Query · Recharts                                 │
│ Auth gate → Executive Overview · Orders Explorer · Order Simulator   │
└───────────────┬──────────────────────────────────────▲───────────────┘
                │ RPC (publishable key + user JWT)     │ private broadcast
                ▼                                      │ ("analytics changed")
┌──────────────────────────── Supabase ─────────────────┴──────────────┐
│ Auth          · email/password sessions                              │
│ PostgreSQL 17 · 11 normalized business tables                        │
│               · RLS on every table, allowlist-based membership       │
│               · SECURITY INVOKER analytics functions                 │
│               · operator-only SECURITY DEFINER simulator (private)   │
│ Realtime      · statement-level triggers → private channel           │
└──────────────────────────────────────────────────────────────────────┘
```

**Design principles**

- **Server-side aggregation.** Every KPI is computed by parameterized SQL functions; no client-side aggregation of raw orders.
- **Least privilege.** Client roles hold read-only grants; all writes go through narrowly scoped, audited database functions.
- **No data over the wire for live updates.** Realtime messages contain only a change signal; data is always re-read through RLS-protected functions.
- **Correctness by construction.** Monetary values in integer paise, IST reporting dates, null-safe rates, and per-order pre-aggregation to prevent join double-counting.

## Tech stack

| Layer | Technologies |
|---|---|
| Frontend | React 19, TypeScript 6, Vite 8, Tailwind CSS 4, shadcn/ui (Base UI), Recharts 3, TanStack Query 5, Lucide |
| Backend | Supabase: PostgreSQL 17, Auth, Realtime (Broadcast from Database, private channels) |
| Data generation | Deterministic Node.js generator (seeded PRNG), batched transactional loader |
| Quality | Node test runner, SQL test suites, PGlite (in-memory PostgreSQL) for offline database testing, oxlint |

## Security model

| Control | Implementation |
|---|---|
| Authentication | Supabase Auth; self-registration grants no data access |
| Authorization | `private.dashboard_members` allowlist (non-exposed schema) with `viewer` and `operator` roles; self-approval blocked by grants and a guard trigger |
| Row Level Security | Enabled on all business tables; SELECT policies scoped to active members; no client write policies |
| Privileges | Explicit `REVOKE`/`GRANT` review; `TRUNCATE`, sequence and function access removed from client roles; safe default privileges for future objects |
| Functions | Analytics functions are `SECURITY INVOKER` with fixed `search_path`; the few `SECURITY DEFINER` functions live in a private schema and re-verify the caller |
| Realtime | Private channel authorized by a `realtime.messages` policy (approved members only); no client INSERT policy, so signals cannot be spoofed |
| Simulator | Operator check per call, advisory locking, rate limiting (1 tick / 2 s), hard caps (25 orders per tick, 500 open, 20,000 total) |
| Secrets | Browser uses only the publishable key; the app refuses to start with a service-role or secret key; all `.env` files are git-ignored |

## Data model and dataset

**Schema:** `cities`, `dark_stores`, `products`, `inventory`, `inventory_events`, `riders`,
`orders`, `order_items`, `order_status_events`, `delivery_events`, `refunds`, with full
foreign keys, CHECK constraints, an enforced order state machine and generated reporting columns
(IST order date, delivery duration, SLA attainment).

**Synthetic dataset**

| Metric | Value |
|---|---|
| Orders | 20,000 over 90 days (16 Jul – 13 Oct 2026, IST) |
| Network | 5 cities · 16 live dark stores (+1 planned) · 112 SKUs in 12 categories · 113 riders |
| Total rows | ~590,000 (items, stock ledger, status history, delivery timeline, refunds) |
| Headline KPIs | GMV ₹85.7 L · AOV ₹440 · Avg delivery 8.3 min · On-time 77.6% · Cancellation 2.7% |

The generator models peak hours, weekend and festival demand, monsoon slowdowns, rider
availability, stockouts with partial fulfilment, cancellations and refunds. It is fully
deterministic, and 27 data-quality rules validate reconciliation, ledger consistency, refund
limits and lifecycle validity.

KPI definitions and formulas are documented in [`docs/kpi-dictionary.md`](docs/kpi-dictionary.md).

## Getting started

**Prerequisites:** Node.js 22.18+ (developed on Node 24 LTS) and a Supabase project.

```bash
npm install
```

1. **Database.** Apply the migrations in `supabase/migrations/` in order (`001` → `005`) via the Supabase SQL Editor.
2. **Seed data (optional).** Follow [`supabase/seed/README.md`](supabase/seed/README.md) to load the synthetic dataset.
3. **Configuration.** Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
4. **Access.** Create a user under *Authentication → Users* and add it to the allowlist:
   ```sql
   insert into private.dashboard_members (user_id, approved_by, role)
   select id, 'owner', 'viewer' from auth.users where email = 'you@example.com';
   -- use 'operator' to enable the Order Simulator
   ```
5. **Run.**
   ```bash
   npm run dev
   ```
   The dashboard is served at `http://localhost:5173`.

## Testing

| Command | Scope | Result |
|---|---|---|
| `npm run test:unit` | Date logic, KPI mapping, routing, live-refresh and simulator controllers | 44 / 44 |
| `npm run test:db` | Authentication, RLS, grants and privilege boundaries | 99 / 99 |
| `npm run test:analytics` | KPI accuracy, reconciliation, filters, pagination, access | 86 / 86 |
| `npm run test:realtime` | Signal emission, payload content, channel authorization | 21 / 21 |
| `npm run test:simulator` | Operator access, limits, lifecycle integrity, exact reset | 27 / 27 |
| `npm run build` · `npm run lint` | Type-checking, production build and static analysis | Passing |

Database suites run against an in-memory PostgreSQL instance and never touch live data. The
corresponding `.test.sql` files in `supabase/tests/` can also be executed in the Supabase SQL
Editor; every change they make is rolled back.

## Project structure

```
src/
  pages/              Executive Overview, Orders Explorer, Order Simulator, sign-in
  components/         layout, dashboard, chart and UI components
  hooks/ · lib/       data access, analytics mappers, live refresh, simulator runner
supabase/
  migrations/         001 schema · 002 auth & RLS · 003 analytics · 004 realtime · 005 simulator
  tests/              SQL test suites and local test runners
  seed/               data-quality validation, metrics and seeding guide
scripts/seed/         deterministic dataset generator and loader
docs/                 KPI dictionary
```

## Known limitations

- The synthetic dataset ends on 13 October 2026; date presets anchor to the latest available day.
- Live refreshes are throttled to at most one every 15 seconds by design.
- The simulator is driven from an open browser session and stops automatically after 30 minutes.
- Delivery & SLA, Inventory and Reports views are planned; the corresponding analytics functions already exist in the database.

## Acknowledgements

Developed by **[prathamhirolikar7-hash](https://github.com/prathamhirolikar7-hash)** as a
Business Analyst portfolio project.

**Built with [Claude](https://claude.ai)** (Anthropic). The application, database design,
security model, synthetic data pipeline and test suites were developed iteratively in
collaboration with Claude using Claude Code.
