# Deal Radar — Design Specification

**Date:** 2026-10-17
**Status:** Approved design, ready for implementation planning
**Owner:** Abid Hasan (PeraByte AI)
**Repo:** `deal-radar` (public GitHub repository)
**Deadline driver:** Black Friday 2026 = 27 November 2026. Deals are already live; the system must be collecting before mid-November.

---

## 1. Problem

PeraByte AI buys a meaningful amount of software to run its service lines: LLM subscriptions and API credits, AI video/image/voice tools, AI coding tools, hosting and infrastructure, agency operations SaaS, and storage/assets.

Every November these vendors run steep, short-lived discounts. The failure mode is not "we found no deals" — it is **missing a deal that was live for two days**.

A second, known constraint applies: paying from Bangladesh is awkward. PayPal does not operate in the country, many locally issued cards ship with international transactions disabled, and some vendors reject Bangladeshi billing addresses or IPs. **v1 does not attempt to model this** — it is handled by checking a vendor by hand when a deal is worth acting on. See §13.

## 2. Goal

A system that automatically watches a defined set of vendors across six categories, detects new deals, scores them against what PeraByte actually intends to buy, and surfaces the result in a web dashboard with Telegram push for matched deals.

**Success in one sentence:** during November, no relevant deal is missed, and nothing in the dashboard is stale or silently broken.

## 3. Non-goals (v1)

- **No auto-purchase.** The system never buys anything. Not now, not later.
- **No payability database.** Vendors' Bangladesh payment status is checked manually when a deal matters. No `bd_status`, no badge, no scoring term — see §13.
- **No user accounts or multi-tenancy.** Single operator. The dashboard is protected by Vercel deployment protection.
- **No price-history charts.** Only current and previous price.
- **No regional-pricing engine.** Explicitly deferred.
- **No email channel.** Telegram only.
- **No VPS dependency.** Everything runs on free managed tiers. The collector is written as a portable script over Postgres so it *can* move to the PeraByte Coolify VPS later without a rewrite — but v1 does not require it.
- **No scraping of vendors whose terms forbid it.** Such vendors are left out of the watchlist, or included with `enabled: false` and a note recording why.

## 4. Architecture

```
GitHub Actions (every 15 min)          Next.js on Vercel
  collector/                             web/
      │                                     │
      │  writes deals, runs, health         │  reads only
      ▼                                     ▼
            Neon Postgres (Free plan)
                      │
                      ▼
            Telegram Bot API
```

**Why the collector is not in Vercel.** Vercel Hobby functions cap at 60 seconds. Polling ~100 sources with LLM extraction does not fit in one invocation, and sharding to force it adds fragility without benefit. GitHub Actions provides a 6-hour budget per job, so there is no time pressure.

**Why Vercel Cron is not the scheduler.** Vercel Hobby restricts cron jobs to **once per day**, and expressions running more frequently fail deployment. Deals sell out in hours, so daily polling would defeat the entire purpose.

**Why GitHub Actions.** It is free for public repositories, supports a 5-minute minimum interval, and runs arbitrary long jobs. Its documented unreliability (delays, dropped runs, 60-day inactivity disable) is handled explicitly in §10.

## 5. Repository layout

One repository, one shared schema, two deployables.

```
deal-radar/
  collector/
    adapters/
      rss.ts             # RSS/Atom feeds
      hackernews.ts      # HN Algolia API
      reddit.ts          # Reddit JSON endpoints
      llm-page.ts        # vendor page → LLM extraction
    fetcher.ts           # politeness, caching, change detection
    extract.ts           # LLM → validated JSON + confidence
    normalise.ts         # currency, dates, discount %, fingerprint
    dedupe.ts            # NEW | UPDATED | DUPLICATE
    score.ts             # pure function
    alert.ts             # Telegram send + dedupe + rate limit
    heartbeat.ts         # dead-man's switch ping
    index.ts             # orchestration and run logging
  db/
    schema.sql
    migrations/
  watchlist.yaml         # vendors, sources, tiers
  web/                   # Next.js App Router, read-mostly
    app/
      page.tsx           # deals table
      review/page.tsx    # needs-review queue
      sources/page.tsx   # source health
      targets/page.tsx   # what we intend to buy
      runs/page.tsx      # run log
      api/deals/route.ts
  .github/workflows/
    collect.yml
    keepalive.yml
  docs/superpowers/specs/
```

## 6. Components

Each is a deep module: small interface, substantial internals, independently testable.

| Module | Interface | Responsibility |
|---|---|---|
| `watchlist` | `load() → Vendor[]`, `dueSources(now) → Source[]` | Parse and validate `watchlist.yaml`; seed DB; select due sources by cadence |
| `fetcher` | `fetch(url) → {status, body, hash, changed}` | HTTP with robots.txt respect, per-domain rate limit, identifiable UA, timeout, exponential backoff, ETag/Last-Modified caching, content hashing |
| `adapters.*` | `fetchDeals(source) → RawDeal[]` | One per source kind. Adding a source kind means adding one file |
| `extract` | `extract(text, vendor) → {deals, confidence}` | LLM call with strict JSON schema, schema validation, one repair retry |
| `normalise` | `normalise(raw) → Deal` | Currency, ISO dates, discount % computation, fingerprint generation |
| `dedupe` | `classify(deal) → NEW \| UPDATED \| DUPLICATE` | Fingerprint match, then fuzzy title+price match within vendor |
| `score` | `score(deal, targets) → {score, breakdown}` | Pure function. No I/O |
| `store` | narrow repository methods | All SQL. Swap to another Postgres by reimplementing this one module |
| `alert` | `notify(deal) → AlertResult` | Telegram send, per-deal dedupe, rate limiting |
| `heartbeat` | `ping() → void` | Dead-man's switch ping on successful run |
| `collector` | `runOnce() → RunSummary` | Orchestration, per-source isolation, run logging |

## 7. Data model (Neon Postgres)

**`vendor`** — `id`, `slug` (unique), `name`, `category` (enum: `llm`, `media`, `devtools`, `hosting`, `ops`, `storage`), `tier` (1|2), `website`, `service_line` (which PeraByte service this supports, nullable)

**`source`** — `id`, `vendor_id`, `url`, `kind` (enum: `rss`, `api`, `page`), `adapter` (enum: `rss`, `hackernews`, `reddit`, `llm_page`), `cadence_minutes`, `enabled`, `note`, `last_checked_at`, `last_changed_at`, `content_hash`, `consecutive_failures`, `health` (enum: `ok`, `degraded`, `failing`, `disabled`)

**`deal`** — `id`, `vendor_id`, `source_id`, `title`, `summary`, `price_now` (numeric), `price_was` (numeric, nullable), `currency`, `discount_pct` (numeric, nullable), `promo_code`, `starts_at`, `ends_at`, `url`, `eligibility_note`, `confidence` (numeric 0–1), `status` (enum: `published`, `needs_review`, `rejected`, `expired`), `score` (numeric), `score_breakdown` (jsonb), `fingerprint` (unique), `first_seen_at`, `last_seen_at`

**`alert`** — `id`, `deal_id`, `channel` (`telegram`), `sent_at`, `status` (`sent`, `failed`)

**`target`** — `id`, `vendor_id` (nullable), `keyword` (nullable), `max_price`, `priority`, `active`

**`run_log`** — `id`, `started_at`, `finished_at`, `sources_checked`, `sources_failed`, `pages_fetched`, `extractions_ok`, `extractions_low_confidence`, `new_deals`, `errors` (jsonb)

`deal.fingerprint` is a SHA-256 of `vendor_id + normalised title + price_now + promo_code`. It is what makes every run idempotent — a delayed or duplicated run cannot create duplicates.

## 8. Data flow

```
runOnce():
  for each source where enabled and due:
    try:
      res = fetcher.fetch(source.url)
      if source.kind == 'page' and not res.changed:
          record check, continue            # skip LLM entirely
      raws = adapter.fetchDeals(source)     # or extract() for llm_page
      for raw in raws:
        d = normalise(raw)
        if d.confidence < CONFIDENCE_FLOOR:
            store(status='needs_review'); continue
        if dedupe.classify(d) == DUPLICATE / UPDATED:
            store(upsert); continue
        d.score, d.breakdown = score(d, targets)
        store(d, status='published')
        if matchesTarget(d) and d.score >= ALERT_THRESHOLD:
            alert.notify(d)
      source.consecutive_failures = 0; source.health = 'ok'
    except:
      source.consecutive_failures += 1
      update health: >2 → 'degraded', >5 → 'failing'
      log error; continue                    # never abort the run
  write run_log
  heartbeat.ping()
```

Per-source isolation is absolute: one failing vendor never aborts a run or affects another vendor.

## 9. Score calculation

`score = 3·relevance + 2·log10(savings_usd + 1) + 1.5·(discount_pct/10) + 2·urgency`

| Component | Definition |
|---|---|
| `relevance` | 0–5. Does the vendor map to an active `target`, or to a declared PeraByte service line? |
| `savings_usd` | `price_was − price_now`, converted to USD. Unknown `price_was` → 0 |
| `discount_pct` | As advertised, or computed. Unknown → 0 |
| `urgency` | 2 if `ends_at` within 72 h; 1 if within 7 days; 0 otherwise |

Weights live in config so they can be tuned without code changes. `ALERT_THRESHOLD` defaults to 8 and should be re-tuned against real data in the first week — it is a guess, not a measurement.

## 10. Failure handling

This section is the most important in the spec. GitHub Actions fails **silently** by design — documented delays of 6–51 minutes, runs dropped with no failed-run record, and scheduled workflows disabled after 60 days of repository inactivity.

| Failure | Detection | Response |
|---|---|---|
| **Scheduler stops entirely** | `heartbeat.ts` pings a heartbeat URL on every successful run | If no ping for N hours, Telegram alerts the operator. **This is the single most important defence in the system.** |
| 60-day inactivity disable | Weekly `keepalive.yml` makes a trivial commit | Schedule stays enabled |
| Delayed or dropped run | `fingerprint` uniqueness + `dueSources(now)` logic | Delayed run simply picks up what is due. Duplicate run is a no-op |
| Vendor page redesign | Content hash changes but extraction returns no deals, twice in a row | `source.health` → `degraded`, visible on the Sources page |
| LLM returns invalid JSON | Schema validation | One repair retry, then `status='needs_review'` |
| Vendor blocks automation (403/429) | HTTP status | Backoff, `consecutive_failures` increments, source marked `failing` |
| Telegram send fails | API response | `alert.status='failed'`; retried on next run. The deal is never lost |
| Neon compute suspended | Next query resumes it (a few hundred ms) | No action needed; scale-to-zero is expected on Free |

**Heartbeat implementation.** `HEARTBEAT_URL` points at an external dead-man's-switch service (for example healthchecks.io) configured to notify the same Telegram chat when pings stop arriving. If `HEARTBEAT_URL` is unset, the ping is skipped and this defence is inactive — the system then degrades to the health page as its only signal. The mechanism is deliberately provider-agnostic: any URL that raises an alert on silence works.

## 11. Scheduling and cost

| Parameter | Value |
|---|---|
| Tier 1 cadence (`cadence_minutes`) | 15 |
| Tier 2 cadence | 360 |
| Repository visibility | **Public** — unlimited Actions minutes |
| Estimated Actions usage | ~2,880 runs/month ≈ 2,880 minutes (this would exceed the 2,000-minute private-repo allowance, which is why the repository is public) |
| Neon Free | 100 CU-hours/project/month. Scale-to-zero covers idle periods. 1 GB storage is far beyond need |
| LLM cost | Bounded by change detection — the model is called only when a page's content hash changes |
| Vercel Hobby | Free tier. **No cron jobs in v1.** Hobby permits only daily schedules, which is too slow for the collection loop, so all scheduling lives in GitHub Actions |

Going public removes the Actions minute constraint entirely and doubles as a portfolio artefact for PeraByte.

## 12. Watchlist

`watchlist.yaml` is the single source of truth for what is watched. Tier 1 is the ~30 vendors that would realistically be bought this November; Tier 2 is everything else.

**Tier 1 seed (initial set):**

| Category | Vendors |
|---|---|
| `llm` | OpenAI, Anthropic, Google Gemini, Perplexity, xAI, Mistral, DeepSeek, OpenRouter |
| `media` | Higgsfield, Runway, Kling, Luma, Midjourney, ElevenLabs, HeyGen, Descript |
| `devtools` | Cursor, GitHub Copilot, Windsurf, Replit, v0 |
| `hosting` | Hetzner, RackNerd, HostHatch, Netcup, DigitalOcean, Vultr, Namecheap, Porkbun |
| `ops` | Notion, Linear, Figma, Canva, Zapier, Make, n8n, Airtable |
| `storage` | Backblaze, pCloud, Envato Elements |

The seed is a starting point, not a commitment — the file is meant to be edited freely as the season develops.

## 13. Payability (deferred to v2)

Deliberately **out of v1**. Vendor payment status for Bangladesh is checked by hand when a deal is worth acting on; it is not modelled, scored, filtered on, or alerted on.

Why it is deferred rather than built:

- The real answer is only discoverable at checkout. A curated table would be confidently wrong as often as it was right without continuous manual re-verification, which is ongoing work with no proof of payoff yet.
- Maintaining ~30 vendor profiles costs real time that is better spent making sure deals are actually *found* before making sure they are annotated.

What this means concretely:

- No `bd_status`, no vendor badge, no payability term in the score, no BD filter in the dashboard.
- `deal.eligibility_note` **stays** — it records conditions the vendor itself states ("new customers only", "region-locked", "annual plans only"). That falls out of extraction for free, so there is no reason to drop it.
- If the tracker earns its keep, a vendor-level payability profile is a clean v2 addition: one new table, no changes to existing rows.

## 14. Dashboard (Next.js App Router, read-mostly)

| Page | Contents |
|---|---|
| `/` Deals | Table: vendor, category, title, price now/was, discount %, code, ends, score. Filters: category, tier, minimum discount, ending within N days, text search. Sort by score, discount, or expiry. |
| `/review` | Deals with `status='needs_review'`. Approve → `published`, Reject → `rejected`. |
| `/sources` | Per source: vendor, kind, last checked, last changed, consecutive failures, health. Makes silent breakage visible. |
| `/targets` | CRUD over `targets`. Drives alerting. |
| `/runs` | Recent `run_log` rows with error detail. |

The web tier never writes to `deal` or `source` except via the review queue. No authentication in code; Vercel deployment protection covers access.

## 15. Testing

| Layer | Approach |
|---|---|
| Adapters | Saved fixture files (HTML/JSON/RSS) → assert `RawDeal[]`. No network in tests |
| Extractor | Recorded LLM responses → assert schema validity and confidence thresholding. No live API calls |
| Normaliser | Unit tests for currency, dates, discount %, fingerprint stability |
| Dedupe | Fingerprint and fuzzy-match cases, including the "same deal, price changed" case |
| Scorer | Pure-function unit tests with fixed inputs |
| Store | Tests against a temporary Postgres schema |
| End-to-end | Fixture source → `runOnce()` → assert deal stored and alert queued, with Telegram and heartbeat mocked |
| Manual | `--dry-run` flag: fetch, extract, print, write nothing |

## 16. Configuration and secrets

Environment variables, stored as GitHub Secrets for the collector and Vercel env vars for the web tier:

`DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `LLM_API_KEY`, `LLM_BASE_URL` (OpenAI-compatible endpoint), `LLM_MODEL`, `HEARTBEAT_URL`, `CONFIDENCE_FLOOR`, `ALERT_THRESHOLD`, `HTTP_USER_AGENT`.

The extractor targets any **OpenAI-compatible chat-completions endpoint**, so the provider is swappable by changing `LLM_BASE_URL` and `LLM_MODEL` — no code change.

## 17. Build order

1. Repo scaffold, `db/schema.sql`, Neon project, `watchlist.yaml` seed
2. `fetcher` + `rss` adapter + `normalise` + `dedupe` + `store` → `collector` runs end to end on one vendor
3. Next.js dashboard reading from Neon, deployed to `deals.perabyteai.com`
4. `llm-page` adapter + confidence gate + `/review`
5. `score` + `targets` + `alert` (Telegram) + `heartbeat`
6. `/sources` health page + `/runs`
7. `collect.yml` hardening (retries, `workflow_dispatch`), `keepalive.yml`
8. Add Tier 2 vendors progressively

## 18. Risks

| Risk | Mitigation |
|---|---|
| Vendor blocks automated collection | Feed/API first; vendors whose terms forbid collection are excluded by policy; health page makes blocks visible |
| LLM extraction cost spikes | Change detection gates every model call; Tier 2 polled every 6 hours |
| Watchlist breadth (100+ vendors) overwhelms Tier 1 quality | Strict tiering; Tier 1 hand-curated first, Tier 2 added progressively |
| GitHub Actions silently stops | Heartbeat + Telegram, keepalive commit, `workflow_dispatch` |
| Watchlist decays after November | Deliberate — the system is designed to be switched off and re-enabled next November with no rot, since sources are declarative |
| `ALERT_THRESHOLD` is a guess | Re-tune against real data in the first week of collection; alert fatigue is the failure mode to watch for |

## 19. Resolved decisions

- Repository: **public** GitHub repo `deal-radar`
- Database: **new dedicated Neon project** (not the existing idle `Inkeep-Agents` project)
- Dashboard: **`deals.perabyteai.com`** via Namecheap CNAME → Vercel. Apex and `www` untouched
- Collector host: **GitHub Actions**, 15-minute Tier 1 cadence
- Output: **web dashboard + Telegram alerts**
- Coverage: **all six categories**, tiered
- Payability: **deferred to v2** — checked manually in the meantime
