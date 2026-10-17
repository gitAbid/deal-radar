# Deal Radar

An automated Black Friday deal tracker for PeraByte AI. It watches a defined set of
vendors across six categories, detects new deals, scores them against what we
actually intend to buy, and pushes matches to Telegram.

It is built for one operator, and it never buys anything.

## Architecture

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

Nothing runs on a server. The collector is a plain script over Postgres, so it can
move to the PeraByte Coolify VPS later if that ever becomes worthwhile.

**Why the split.** Vercel Hobby functions cap at 60 seconds, which is not enough to
poll ~100 sources with LLM extraction. Vercel Hobby cron is also limited to **once
per day**, and deals sell out in hours. So collection runs in GitHub Actions, which
is free for public repos and allows long jobs, and Vercel does what it is good at:
serving a fast dashboard.

## Layout

| Path | What it is |
|---|---|
| `collector/` | The collector. Runs in GitHub Actions. |
| `web/` | Next.js dashboard. Deployed to Vercel. |
| `db/schema.sql` | The schema. Already applied to Neon. |
| `watchlist.yaml` | The single source of truth for what is watched. |
| `docs/superpowers/specs/` | The design spec — read this first. |
| `docs/superpowers/plans/` | The implementation plan. |

## Running it locally

```bash
pnpm install
cp .env.example .env      # then fill it in
pnpm seed                 # upsert watchlist.yaml into vendor + source tables
pnpm collect:dry          # fetch and extract, write nothing
pnpm collect              # the real thing
pnpm test
pnpm typecheck
```

## Configuration

Set these as **GitHub Secrets** for the collector and as **Vercel environment
variables** for the dashboard.

| Name | Kind | Purpose |
|---|---|---|
| `DATABASE_URL` | secret | Pooled Neon connection string |
| `TELEGRAM_BOT_TOKEN` | secret | From @BotFather |
| `TELEGRAM_CHAT_ID` | secret | Where alerts go |
| `LLM_API_KEY` | secret | Any OpenAI-compatible provider |
| `HEARTBEAT_URL` | secret | Dead-man's switch (see below) |
| `LLM_BASE_URL` | var | e.g. `https://api.openai.com/v1` |
| `LLM_MODEL` | var | e.g. `gpt-4o-mini` |
| `CONFIDENCE_FLOOR` | var | Default `0.6` |
| `ALERT_THRESHOLD` | var | Default `8` |
| `HTTP_USER_AGENT` | var | Identifies us to vendors. Keep it honest. |

The extractor targets any OpenAI-compatible chat-completions endpoint, so the
provider is swappable by changing `LLM_BASE_URL` and `LLM_MODEL`. No code change.

## This system fails silently, by design of the platform

GitHub Actions scheduled runs are **best-effort**. They are routinely delayed 6–51
minutes, occasionally dropped entirely with no failed-run record, and a scheduled
workflow is **disabled after 60 days of repository inactivity** — silently. For a
tool whose whole purpose is noticing things, that is the most dangerous failure
mode there is.

Three defences, and they matter more than any feature here:

1. **Dead-man's switch.** The collector pings `HEARTBEAT_URL` after every
   successful run. Point it at an external monitor (healthchecks.io or equivalent)
   configured to message the same Telegram chat when pings stop. This is the most
   important thing in the system. If `HEARTBEAT_URL` is unset, this defence is
   **inactive**.
2. **`keepalive.yml`** makes a trivial weekly commit so the schedule stays armed.
3. **`workflow_dispatch`** on every workflow, so a run can always be triggered by
   hand.

Two more properties keep delayed or duplicated runs harmless:

- `deal.fingerprint` is unique, so re-running cannot create duplicates.
- `dueSources()` only selects sources whose cadence has elapsed, so a late run
  simply picks up whatever is due.

Watch the **`/sources`** page in the dashboard. It is there to make silent breakage
visible — anything `degraded` or `failing` sorts to the top.

## Vendor-page sources are unverified

Vendor deal and pricing URLs in `watchlist.yaml` marked `note: unverified` have not
been checked against the live site. The `/sources` page is the verification
mechanism. Fix the URL, or set `enabled: false` to silence it.

Some vendors forbid automated collection. Those are listed with no sources at all
and are picked up via community feeds (Hacker News, Reddit, LowEndTalk) instead.
**Do not add a source for a vendor you have not cleared.**

## Not in v1

No auto-purchase. No payability database — Bangladesh payment status is checked by
hand when a deal matters. No user accounts. No price-history charts. No email.
