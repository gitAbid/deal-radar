# Deal Radar dashboard (`web/`)

Read-mostly Next.js (App Router) dashboard over the same Neon Postgres database the collector
writes to. Single operator, internal tool. There is no auth in code — access is covered by Vercel
Deployment Protection.

## Pages

| Route | What it shows |
|---|---|
| `/` | Published deals. Filters (category, tier, minimum discount, ending within N days, text search) live in `searchParams`, so every view is a linkable URL. Default sort `score DESC`, ending-soon rows highlighted. |
| `/review` | Deals with `status = 'needs_review'`. Approve → `published`, Reject → `rejected`. These Server Actions are the only writes in the app. |
| `/sources` | Per-source collection health. Degraded and failing sources sort to the top; that is how silent breakage is noticed. |
| `/targets` | Targets that drive scoring relevance and alerts. Create/edit/pause/delete via Server Actions — an active target matching on vendor or keyword is the only way a Telegram alert can fire. |
| `/runs` | Recent `run_log` rows with the `errors` JSONB expanded into readable lines. |
| `/api/deals` | The deals list as JSON. Accepts the same query params as `/`: `category`, `tier`, `min_discount`, `ending_days`, `q`, `sort=score\|discount\|ending`. |

Every page renders against an empty database: empty states, not errors. A database outage renders
`app/error.tsx` rather than a stack trace.

## Environment

One variable, needed both locally and in Vercel:

| Variable | Value |
|---|---|
| `DATABASE_URL` | The pooled Neon connection string for the `dealradar` database (Neon dashboard → Connection details → Pooled connection). |

Local setup:

```bash
pnpm install
printf 'DATABASE_URL=%s\n' '<pooled connection string>' > .env.local   # gitignored
pnpm dev
```

Within `web/`, the connection string lives only in `.env.local` (gitignored) — it is never written
into code, this README, or `vercel.json`. The only other place it lives is the Vercel project env
settings. Do not commit it anywhere.

## Deploy (Vercel)

1. Import the GitHub repo in Vercel and set **Root Directory** to `web`.
2. Framework preset: **Next.js**. Build and install commands: defaults (`pnpm build` / `pnpm install`).
3. Add the `DATABASE_URL` environment variable (Production and Preview).
4. **No Vercel Cron jobs.** v1 schedules collection exclusively from GitHub Actions (spec §11:
   Hobby cron is once per day, far too slow for a 15-minute collection loop). `vercel.json`
   deliberately declares none.
5. Enable Deployment Protection so the dashboard is not publicly reachable.

## Custom domain (`deals.perabyteai.com`)

At Namecheap (Domain List → Manage → Advanced DNS), add:

| Type | Host | Value | TTL |
|---|---|---|---|
| CNAME Record | `deals` | `cname.vercel-dns.com` | Automatic |

Then add `deals.perabyteai.com` under the Vercel project's Domains. Leave the apex and `www`
records untouched — only the `deals` subdomain points at Vercel.

## Notes

- All data fetching happens in server components through a single module-level `pg` pool
  (`lib/db.ts`): one pool per process, never one per request. `NUMERIC`/`BIGINT` columns are
  parsed to JS numbers once, globally, in the same file.
- Pages are rendered per request (Next.js Cache Components: async data lives behind `<Suspense>`
  with `connection()`), so the dashboard is never a build-time snapshot of the database.
- The web tier never writes to `deal` or `source` except the review queue; `target` is managed from `/targets` (the dashboard's other write path).
