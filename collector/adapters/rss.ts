/**
 * RSS/Atom feeds via rss-parser.
 *
 * Vendor feeds are filtered to deal-shaped titles. Discovery feeds
 * (service_line: discovery) emit everything at 0.5 confidence, because a
 * community mention is a lead, not a verified deal.
 */

import Parser from 'rss-parser';
import type { Adapter, RawDeal } from './types.js';
import { DEAL_PATTERN, DISCOVERY_FIELDS, isDiscovery, str, text } from './shared.js';

export function createRssAdapter(): Adapter {
  const parser = new Parser();

  return {
    name: 'rss',
    async fetchDeals(ctx): Promise<RawDeal[]> {
      try {
        const feed = await parser.parseString(ctx.body);
        const items = Array.isArray(feed.items) ? feed.items : [];
        const discovery = isDiscovery(ctx.vendor);
        const deals: RawDeal[] = [];

        for (const item of items) {
          const title = str(item.title);
          if (title === null) continue;
          if (!discovery && !DEAL_PATTERN.test(title)) continue;

          deals.push({
            title,
            summary: text(item.contentSnippet ?? item.summary ?? item.content),
            url: str(item.link, 2000),
            starts_at: str(item.isoDate ?? item.pubDate, 64),
            ...(discovery ? DISCOVERY_FIELDS : {}),
          });
        }

        return deals;
      } catch {
        return [];
      }
    },
  };
}
