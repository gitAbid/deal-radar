# Deal Radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Deal Radar collector and dashboard described in `docs/superpowers/specs/2026-10-17-deal-radar-design.md`.

**Architecture:** A TypeScript collector that runs in GitHub Actions, writing to Neon Postgres. A separate Next.js app on Vercel reads the same database and renders the dashboard. Nothing runs on a server.

**Tech Stack:** TypeScript (ESM), Node 20+, `tsx`, `vitest`, `pg`, `yaml`, `rss-parser`. Next.js App Router + Tailwind on Vercel. Neon Postgres 17.

---

## State already in place (do not recreate)

| Thing | Value |
|---|---|
| GitHub repo | `gitAbid/deal-radar` (public) |
| Neon project | `proud-scene-58982270`, branch `main` (`br-calm-snow-b8pbhh8x`), db `dealradar`, pg 17, `aws-us-east-1` |
| Schema | `db/schema.sql` — **already applied** to the live database |
| Shared types | `collector/types.ts` — **frozen**; interfaces mirror column names exactly |
| Watchlist | `watchlist.yaml` — 41 vendors + 5 community feeds |
| Config template | `.env.example` |

`db/schema.sql`, `collector/types.ts` and `watchlist.yaml` are **frozen interfaces**. Do not rename columns or fields. If something genuinely does not fit, stop and report rather than changing the shape.

The live `DATABASE_URL` is **not in the repo**. It is a pooled Neon URI. Each worker needs it exported locally to run integration tests; ask the orchestrator for it rather than inventing one.

---

## File Structure

```
deal-radar/
  collector/
    types.ts            FROZEN — shared types + Adapter contract
    store.ts            All SQL. Only file that talks to Postgres.
    watchlist.ts        Parse watchlist.yaml → Vendor[]/Source[]; dueSources(now)
    seed.ts             Upsert watchlist into vendor + source tables
    fetcher.ts          HTTP: backoff, per-domain rate limit, ETag, content hash
    normalise.ts        RawDeal → Deal (currency, dates, discount %, fingerprint)
    dedupe.ts           fingerprint + fuzzy match → NEW | UPDATED | DUPLICATE
    score.ts            Pure scoring function
    extract.ts          LLM extraction → validated RawDeal[] + confidence
    alert.ts            Telegram send + dedupe + rate limit
    heartbeat.ts        Dead-man's-switch ping
    index.ts            Orchestration, run logging, --dry-run
    adapters/
      types.ts          Barrel re-export of Adapter/AdapterContext from ../types.ts
      rss.ts            RSS/Atom
      hackernews.ts     HN Algolia API
      reddit.ts         Reddit search JSON
      llm-page.ts       Vendor page → LLM
  tests/
    *.test.ts           vitest specs mirroring collector/ layout
    fixtures/           Saved HTML/JSON/RSS + recorded LLM responses
  db/schema.sql         FROZEN — already applied
  watchlist.yaml        FROZEN (editable content, fixed shape)
  web/                  Next.js dashboard (own package.json)
  .github/workflows/    collect.yml, keepalive.yml
```

---

## Workstream A — Collector core

Owner: subagent A. Owns `store.ts`, `watchlist.ts`, `seed.ts`, `fetcher.ts`, `normalise.ts`, `dedupe.ts`, `score.ts`, `adapters/types.ts`, `adapters/rss.ts`, `adapters/hackernews.ts`, `adapters/reddit.ts`, `index.ts`, and matching tests. Also owns `package.json` (runs `pnpm add`).

### Task A1: Dependencies and test harness

- [ ] Install: `pnpm add pg yaml rss-parser` and `pnpm add -D vitest typescript tsx @types/node @types/pg`
- [ ] Create `vitest.config.ts` with `environment: 'node'`, `include: ['tests/**/*.test.ts']`
- [ ] Add `collector/smoke.ts` that imports `pg` and runs `SELECT 1`
- [ ] Run `pnpm typecheck` — expect 0 errors
- [ ] Create `tests/fixtures/` and commit a `.gitkeep`
- [ ] Commit: `chore: collector deps and test harness`

**Acceptance:** `pnpm typecheck` and `pnpm vitest run` both exit 0.

### Task A2: `normalise.ts` — TDD

Implement, test-first:

```ts
export function fingerprint(vendorId: number, title: string, priceNow?: number|null, promoCode?: string|null): string
export function computeDiscountPct(priceNow?: number|null, priceWas?: number|null): number | null
export function parseDate(value?: string|Date|null): Date | null
export function normalise(raw: RawDeal, ctx: {vendorId: number; sourceId?: number|null; confidenceFloor: number}): Deal
```

Rules to test explicitly:
- `fingerprint` is a SHA-256 hex string, stable across calls, and **case/whitespace insensitive on title** (`"  Big SALE "` == `"big sale"`). Same deal with a *different* price must produce a **different** fingerprint.
- `computeDiscountPct(40, 100)` → `60`; `(null, 100)` → `null`; `(120, 100)` (price rise) → `null`, not a negative number.
- `parseDate(null)` → `null`; unparseable string → `null` (never `Invalid Date`).
- `normalise` defaults `currency` to `'USD'`, clamps `confidence` into 0–1, and lowercases `currency`.

- [ ] Write `tests/normalise.test.ts` with the cases above
- [ ] Run `pnpm vitest run tests/normalise.test.ts` — expect FAIL (module not found)
- [ ] Implement `collector/normalise.ts`
- [ ] Run again — expect PASS
- [ ] Commit: `feat: normalise + fingerprint with tests`

### Task A3: `score.ts` — TDD

```ts
export function score(deal: Deal, targets: Target[], weights?: ScoreWeights): {score: number; breakdown: ScoreBreakdown}
```

Formula (from spec §9): `3·relevance + 2·log10(savings_usd + 1) + 1.5·(discount_pct/10) + 2·urgency`

- `relevance` 0–5: 5 if the deal's vendor matches an active target's `vendor_id`; 3 if any active target's `keyword` appears in title/summary (case-insensitive); 2 if the vendor has a non-null `service_line`; else 0.
- `savings_usd = price_was - price_now` when both present and positive, else 0.
- `urgency`: 2 if `ends_at` within 72h, 1 if within 7 days, 0 otherwise. Past dates → 0. Missing → 0.
- `breakdown.total` must equal `score`.
- Weights overridable via the second argument; defaults exported as `DEFAULT_WEIGHTS`.

- [ ] Test-first, including: no targets → relevance 0; keyword match case-insensitive; `ends_at` exactly 72h/7d boundaries; `score` is deterministic for identical input
- [ ] Implement, run, commit: `feat: deal scoring`

### Task A4: `store.ts`

Thin repository. No business logic. Functions (all `async`):

```ts
createPool(databaseUrl: string): Pool
upsertVendor(v: Vendor): Promise<Vendor>                     // conflict on slug
upsertSource(vendorId: number, s: Omit<Source,'id'|'vendor_id'>): Promise<Source>  // conflict on (vendor_id, url)
listDueSources(now: Date): Promise<Array<Source & {vendor: Vendor}>>   // enabled AND (last_checked_at IS NULL OR last_checked_at + cadence_minutes <= now)
markSourceChecked(id: number, r: {hash?: string; changed: boolean; ok: boolean; error?: string}): Promise<void>
recordRunStart(): Promise<number>
recordRunFinish(runId: number, summary: Omit<RunSummary,'runId'>): Promise<void>
findDealByFingerprint(fp: string): Promise<Deal | null>
insertDeal(d: Deal): Promise<Deal>
updateDealSeen(id: number, patch: Partial<Deal>): Promise<void>
listActiveTargets(): Promise<Target[]>
alertsSentFor(dealId: number): Promise<number>
recordAlert(dealId: number, status: 'sent'|'failed', error?: string): Promise<void>
```

Health transitions live in `markSourceChecked`: success → `consecutive_failures = 0`, `health='ok'`; failure → increment, then `>2` → `degraded`, `>5` → `failing`.

- [ ] Implement against the live Neon DB
- [ ] Integration test `tests/store.test.ts` that inserts a vendor + source, lists due sources, records a run, and cleans up after itself. **Skip if `DATABASE_URL` is unset** so CI never needs it.
- [ ] Commit: `feat: postgres store layer`

### Task A5: `watchlist.ts` + `seed.ts`

- [ ] `loadWatchlist(path?)` → parse YAML, validate with zod-free hand checks (slug shape, known category, tier 1|2, adapter known), throw with the offending line on failure
- [ ] `dueSources` logic already lives in SQL (A4) — `watchlist.ts` only parses and validates
- [ ] `seed.ts` → `pnpm seed` upserts every vendor and source; idempotent (run twice, row counts unchanged)
- [ ] Test: `tests/watchlist.test.ts` asserts the real `watchlist.yaml` parses and every adapter name is valid
- [ ] Run `pnpm seed` against live DB, then assert vendor count > 40
- [ ] Commit: `feat: watchlist loader and seeder`

### Task A6: `fetcher.ts`

```ts
export function createFetcher(opts?: {userAgent?: string; minIntervalMs?: number}): {fetch(url: string): Promise<FetchResult>}
```

- Respects robots.txt for `kind: page` (cache per host; allow when robots.txt is unreachable)
- Per-domain minimum interval (default 1000ms), 15s timeout via `AbortSignal.timeout`
- Sends `If-None-Match`/`If-Modified-Since` when the caller supplies a cached hash/etag; `304` → `changed: false`
- `hash` = SHA-256 of the body; `changed` = hash differs from the cached value passed in
- Non-2xx → throws `FetchError` carrying `status`
- 3 attempts with exponential backoff (250ms, 1s, 4s) on 5xx/network; **never** retry 4xx

- [ ] Test with a mocked `globalThis.fetch` — no network in tests
- [ ] Commit: `feat: polite fetcher with caching`

### Task A7: adapters (rss, hackernews, reddit)

Each exports a factory returning an `Adapter`:

```ts
export function createRssAdapter(): Adapter
export function createHackerNewsAdapter(): Adapter
export function createRedditAdapter(): Adapter
```

- `rss.ts` — `rss-parser`; if `source.vendor.service_line === 'discovery'`, emit each item as a RawDeal with `confidence: 0.5` and `eligibility_note: 'community mention, unverified'`. Otherwise filter items whose title matches `/(deal|sale|discount|off|%|promo|black friday)/i`.
- `hackernews.ts` — parse Algolia JSON (`hits[]` → `title`, `url`, `created_at`); same discovery confidence treatment
- `reddit.ts` — parse `data.children[].data` → `title`, `selftext`, `url`, `created_at` (epoch seconds → ISO)
- Every adapter must tolerate malformed input by returning `[]`, never throwing. One test per adapter asserting exactly that.

- [ ] Save one real fixture per adapter into `tests/fixtures/`
- [ ] Test-first per adapter, then implement, then commit each separately

### Task A8: `index.ts` orchestration

```ts
export async function runOnce(opts?: {dryRun?: boolean}): Promise<RunSummary>
```

Implements spec §8 exactly:

- Loads due sources, iterates with **per-source try/catch** so one failure never aborts the run
- For `kind: 'page'` with `changed === false` → record the check and skip the LLM entirely
- Dispatches to the adapter named by `source.adapter`
- `confidence < CONFIDENCE_FLOOR` → store as `needs_review`, continue
- Dedupe → `DUPLICATE` skips, `UPDATED` updates `last_seen_at` + prices, `NEW` scores and inserts `published`
- Alert only when the deal matches an active target **and** `score >= ALERT_THRESHOLD` **and** no successful alert exists for that deal
- Writes `run_log`, then `heartbeat.ping()`
- `--dry-run` writes nothing to `deal`/`source`/`alert` and prints a summary

Imports (frozen signatures — subagent B provides these):
```ts
import { extractDeals } from './extract.js'    // (body, vendor) => {deals: RawDeal[]; confidence: number}
import { notify } from './alert.js'            // (deal, vendorName) => {status:'sent'|'failed'; error?: string}
import { ping } from './heartbeat.js'          // () => Promise<void>
import { createLlmPageAdapter } from './adapters/llm-page.js'
```

- [ ] End-to-end test with fixture sources, Telegram and heartbeat mocked, asserting: a failing source does not abort the run; a low-confidence deal lands in `needs_review`; re-running with the same fixture inserts zero new deals
- [ ] Commit: `feat: collector orchestration`

**Workstream A acceptance:** `pnpm typecheck` clean, `pnpm vitest run` green, and `pnpm collect:dry` prints a summary against the live DB without writing.

---

## Workstream B — Extraction, alerting, heartbeat

Owner: subagent B. Owns `extract.ts`, `adapters/llm-page.ts`, `alert.ts`, `heartbeat.ts` and their tests. **Must not edit `index.ts`, `store.ts`, or `types.ts`** — subagent A owns those. If B needs a change in a frozen file, report it.

### Task B1: `extract.ts`

```ts
export interface ExtractionResult { deals: RawDeal[]; confidence: number; repaired: boolean }
export async function extractDeals(body: string, vendor: {name: string; category: string}): Promise<ExtractionResult>
```

- Calls an **OpenAI-compatible** `POST {LLM_BASE_URL}/chat/completions` with `response_format: {type:'json_object'}`. No SDK — plain `fetch`.
- Prompt asks for `{deals: [...], confidence: number}` where each deal has the `RawDeal` fields plus an `eligibility_note` capturing stated conditions ("new customers only", "annual plans only", "region-locked").
- Strips HTML to text before sending; truncates to ~12k chars; includes the vendor name and category in the prompt.
- Validates the response shape by hand. On invalid JSON or schema violation: **one** repair attempt appending the error message. Then throw.
- Aggregates confidence as the **minimum** across returned deals, not the average — one shaky extraction should not be laundered by confident neighbours.
- Missing `LLM_API_KEY` → throw immediately with a clear message, never silently return `[]`.

- [ ] Record two real LLM responses into `tests/fixtures/` (one valid, one malformed) and test against them with `fetch` mocked. No live API calls in tests.
- [ ] Commit: `feat: llm extraction with repair retry`

### Task B2: `adapters/llm-page.ts`

- [ ] `createLlmPageAdapter()` → `Adapter` that calls `extractDeals(ctx.body, ctx.vendor)` and returns `deals`
- [ ] Test: fixture HTML + mocked LLM → expected `RawDeal[]`
- [ ] Commit: `feat: llm page adapter`

### Task B3: `alert.ts`

```ts
export async function notify(deal: Deal, vendorName: string): Promise<{status:'sent'|'failed'; error?: string}>
```

- `POST https://api.telegram.org/bot{TOKEN}/sendMessage` with `parse_mode: 'HTML'`
- Message: vendor, title, price now/was, discount %, promo code, ends-at in the operator's local timezone, eligibility note, URL
- **Escapes HTML** in every interpolated value — a vendor title containing `<` must not break the message or inject markup
- Never throws: returns `{status:'failed', error}` so the caller records it and the deal is retried next run
- In-process rate limit: max 20 messages/minute

- [ ] Test with mocked `fetch` asserting the payload, and assert that `title: '<script>x</script>'` is escaped in the output
- [ ] Commit: `feat: telegram alerts`

### Task B4: `heartbeat.ts`

- [ ] `ping()` GETs `HEARTBEAT_URL` when set, no-ops with a debug log when unset. Never throws.
- [ ] Test: unset → no fetch call; set → exactly one call; network failure → resolves, does not reject
- [ ] Commit: `feat: heartbeat ping`

---

## Workstream C — Dashboard

Owner: subagent C. Owns everything under `web/`. May not touch `collector/` or `db/`.

### Task C1: Scaffold

- [ ] `pnpm create next-app@latest web --ts --tailwind --app --no-src-dir --import-alias "@/*" --no-eslint`
- [ ] `pnpm add pg` in `web/`; `web/.env.local` with `DATABASE_URL` (gitignored)
- [ ] `web/lib/db.ts` — a module-level `pg.Pool` reused across invocations (Next.js dev reloads create pools otherwise), with `export const query = (sql, params) => pool.query(sql, params)`
- [ ] `web/lib/format.ts` — `money(n, ccy)`, `pct(n)`, `relativeDays(date)`, `badgeClass(...)` helpers
- [ ] Commit: `chore: scaffold web app`

### Task C2: Pages — all read-only, server components

| Route | File | Contents |
|---|---|---|
| `/` | `web/app/page.tsx` | Deals table + filters + sorts |
| `/review` | `web/app/review/page.tsx` | `needs_review` queue with approve/reject |
| `/sources` | `web/app/sources/page.tsx` | Source health |
| `/targets` | `web/app/targets/page.tsx` | Target CRUD |
| `/runs` | `web/app/runs/page.tsx` | Recent runs |
| — | `web/app/api/deals/route.ts` | JSON for the deals list |

Requirements:
- `/` shows only `status='published'`, default sort `score DESC`. Columns: vendor, category, title, price now/was, discount %, code, ends, score. Filters: category, tier, minimum discount, ending within N days, text search — all as `searchParams` so the view is linkable. "Ending soon" rows visually distinct.
- `/sources` is the **most important page**: health pill, last checked, last changed, consecutive failures. Anything `degraded` or `failing` sorts to the top.
- `/review` approve/reject are the **only** writes in the app. Use Server Actions. `revalidatePath` after.
- `/runs` shows the `errors` JSONB expanded, so a silent breakage is readable.
- Every page must render correctly with **zero rows** (empty state text, no crash).

- [ ] Build each page, commit after each
- [ ] Add `web/app/error.tsx` so a DB outage renders an error page rather than a stack trace

### Task C3: Deploy config

- [ ] `web/vercel.json` — no cron jobs (spec §11 forbids them in v1)
- [ ] `web/README.md` — the CNAME record to add at Namecheap: `deals` → `cname.vercel-dns.com`, and the env var to set in Vercel
- [ ] Confirm `pnpm build` succeeds locally
- [ ] Commit: `chore: vercel deploy config`

**Workstream C acceptance:** `pnpm build` in `web/` succeeds; the app runs against the live DB with `DATABASE_URL` set.

---

## Workstream D — Workflows and docs (orchestrator)

- [ ] `.github/workflows/collect.yml` — `schedule: */15 * * * *` + `workflow_dispatch`; `concurrency` group to prevent overlap; `pnpm install --frozen-lockfile`, `pnpm collect`; `DATABASE_URL`, `TELEGRAM_*`, `LLM_*`, `HEARTBEAT_URL` from secrets
- [ ] `.github/workflows/keepalive.yml` — weekly trivial commit (spec §10; GitHub disables schedules after 60 days of repo inactivity)
- [ ] `README.md` — what it is, the architecture diagram, how to run, what each secret is, and the "this fails silently, here is how we detect it" section
- [ ] `.github/workflows/ci.yml` — typecheck + tests on push, no secrets required

---

## Self-review checklist

- [ ] Every §7 table has a matching `store.ts` method (or a documented reason)
- [ ] Every §10 failure row has a corresponding test
- [ ] No `any` in `collector/`; `noUncheckedIndexedAccess` is on
- [ ] No adapter test performs network I/O
- [ ] `DATABASE_URL` appears in no committed file
- [ ] Every page in §14 exists
- [ ] Field names in `web/` match `collector/types.ts` exactly
