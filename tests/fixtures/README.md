# Fixtures

Recorded inputs for the adapter tests. No test performs network I/O.

| File | Provenance |
|---|---|
| `hackernews-search.json` | **Real.** Captured 2026-10-17 from the watchlist URL `https://hn.algolia.com/api/v1/search_by_date?query=black%20friday&tags=story&hitsPerPage=50`, trimmed to the first 10 hits. |
| `rss-feed.rss` | **Real.** Captured 2026-10-17 from `https://news.ycombinator.com/rss`. |
| `reddit-search.json` | **Hand-written** from the documented `search.json` shape (`data.children[].data`). The live endpoint returned HTTP 403 from this network, so a representative payload was written by hand instead; it is structurally faithful, including `created_utc` in epoch seconds. |
| `blocked-cloudflare.html` | **Real.** The body actually returned by `https://lowendtalk.com/categories/deals/feed.rss` (Cloudflare challenge page, HTTP 403) from this network, truncated to 4 kB. Used as the malformed-input case for the RSS adapter: it must yield `[]`, not a throw. |
| `reddit-blocked.html` | **Real.** The body actually returned by `https://www.reddit.com/r/selfhosted/search.json?...` (JS shell page) from this network, truncated to 4 kB. Used as the malformed-input case for the Reddit adapter. |
| `watchlist-bad.yaml` | Hand-written invalid watchlist for the line-numbered validation test in `tests/watchlist.test.ts`. |
| `llm-response-valid.json` | **Hand-written**, not a live recording — no LLM credentials were available in this environment. A structurally faithful OpenAI chat-completions envelope whose `content` holds two deals (per-deal confidences 0.92 and 0.55) plus an overall confidence. |
| `llm-response-malformed.json` | **Hand-written** truncated-JSON content in the same envelope shape, used to exercise the one-repair-attempt path in `tests/extract.test.ts`. |

Provenance rule: every fixture records where it came from. A hand-written fixture must say so here; it may never be described as recorded.
