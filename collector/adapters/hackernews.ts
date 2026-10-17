/**
 * Hacker News via the Algolia search API (watchlist URLs are search_by_date).
 *
 * Hits with no external url point at the HN discussion instead, so the deal
 * can always be traced back to its source.
 */

import type { Adapter, RawDeal } from './types.js';
import { DEAL_PATTERN, DISCOVERY_FIELDS, isDiscovery, isRecord, jsonParse, str, text } from './shared.js';

export function createHackerNewsAdapter(): Adapter {
  return {
    name: 'hackernews',
    async fetchDeals(ctx): Promise<RawDeal[]> {
      const payload = jsonParse(ctx.body);
      if (!isRecord(payload)) return [];
      const hits = payload['hits'];
      if (!Array.isArray(hits)) return [];

      const discovery = isDiscovery(ctx.vendor);
      const deals: RawDeal[] = [];

      for (const hit of hits) {
        if (!isRecord(hit)) continue;
        const title = str(hit['title']);
        if (title === null) continue;
        if (!discovery && !DEAL_PATTERN.test(title)) continue;

        const external = str(hit['url'], 2000);
        const objectId = str(hit['objectID'], 64);
        const discussion =
          objectId === null ? null : `https://news.ycombinator.com/item?id=${objectId}`;

        deals.push({
          title,
          summary: text(hit['story_text']),
          url: external ?? discussion,
          starts_at: str(hit['created_at'], 64),
          ...(discovery ? DISCOVERY_FIELDS : {}),
        });
      }

      return deals;
    },
  };
}
