/**
 * Reddit search JSON (`data.children[].data`).
 *
 * Reddit's `created_utc` is epoch seconds and is converted to ISO here. The
 * url prefers the linked offer over the discussion permalink, because the
 * offer is what the operator actually wants to open.
 */

import type { Adapter, RawDeal } from './types.js';
import {
  DEAL_PATTERN,
  DISCOVERY_FIELDS,
  epochToIso,
  isDiscovery,
  isRecord,
  jsonParse,
  str,
  text,
} from './shared.js';

const REDDIT_URL = /^https?:\/\/(?:www\.|old\.)?reddit\.com\//i;

export function createRedditAdapter(): Adapter {
  return {
    name: 'reddit',
    async fetchDeals(ctx): Promise<RawDeal[]> {
      const payload = jsonParse(ctx.body);
      if (!isRecord(payload)) return [];
      const data = payload['data'];
      if (!isRecord(data)) return [];
      const children = data['children'];
      if (!Array.isArray(children)) return [];

      const discovery = isDiscovery(ctx.vendor);
      const deals: RawDeal[] = [];

      for (const child of children) {
        if (!isRecord(child)) continue;
        const post = child['data'];
        if (!isRecord(post)) continue;
        const title = str(post['title']);
        if (title === null) continue;
        if (!discovery && !DEAL_PATTERN.test(title)) continue;

        deals.push({
          title,
          summary: text(post['selftext']),
          url: offerUrl(post),
          starts_at: epochToIso(post['created_utc']),
          ...(discovery ? DISCOVERY_FIELDS : {}),
        });
      }

      return deals;
    },
  };
}

function offerUrl(post: Record<string, unknown>): string | null {
  const url = str(post['url'], 2000);
  if (url !== null && !REDDIT_URL.test(url)) return url;

  const permalink = str(post['permalink'], 2000);
  if (permalink !== null) {
    return permalink.startsWith('http')
      ? permalink
      : `https://www.reddit.com${permalink.startsWith('/') ? '' : '/'}${permalink}`;
  }
  return url;
}
