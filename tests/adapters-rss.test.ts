import { describe, expect, it } from 'vitest';
import { createRssAdapter } from '../collector/adapters/rss.js';
import { parseDate } from '../collector/normalise.js';
import { fixture, makeContext, makeVendor } from './helpers.js';

const DEAL_RE = /(deal|sale|discount|off|%|promo|black friday)/i;

const SYNTHETIC_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Example Deals</title><link>https://example.com</link>
<item>
  <title>Black Friday 50% off Cursor</title>
  <link>https://example.com/cursor</link>
  <pubDate>Fri, 27 Nov 2026 00:00:00 GMT</pubDate>
  <description><![CDATA[Annual plan is cheaper today.]]></description>
</item>
<item>
  <title>A thoughtful essay about compilers</title>
  <link>https://example.com/essay</link>
  <pubDate>Thu, 26 Nov 2026 00:00:00 GMT</pubDate>
  <description>nothing to see</description>
</item>
</channel></rss>`;

describe('rss adapter', () => {
  it('is named rss', () => {
    expect(createRssAdapter().name).toBe('rss');
  });

  it('parses a real feed without throwing', async () => {
    const deals = await createRssAdapter().fetchDeals(makeContext({ body: fixture('rss-feed.rss') }));
    expect(Array.isArray(deals)).toBe(true);
  });

  it('filters a non-discovery feed down to deal-shaped titles', async () => {
    const deals = await createRssAdapter().fetchDeals(
      makeContext({ body: fixture('rss-feed.rss'), vendor: makeVendor({ service_line: null }) }),
    );
    for (const deal of deals) {
      expect(deal.title.trim().length).toBeGreaterThan(0);
      expect(DEAL_RE.test(deal.title)).toBe(true);
    }
  });

  it('emits every item of a discovery feed at confidence 0.5, flagged unverified', async () => {
    const deals = await createRssAdapter().fetchDeals(
      makeContext({
        body: fixture('rss-feed.rss'),
        vendor: makeVendor({ slug: 'lowendtalk', service_line: 'discovery' }),
      }),
    );
    expect(deals.length).toBeGreaterThan(10);
    for (const deal of deals) {
      expect(deal.confidence).toBe(0.5);
      expect(deal.eligibility_note).toBe('community mention, unverified');
      expect(deal.title.trim().length).toBeGreaterThan(0);
    }
  });

  it('maps item fields onto RawDeal', async () => {
    const deals = await createRssAdapter().fetchDeals(makeContext({ body: SYNTHETIC_FEED }));
    expect(deals).toHaveLength(1);
    const deal = deals[0];
    expect(deal?.title).toBe('Black Friday 50% off Cursor');
    expect(deal?.url).toBe('https://example.com/cursor');
    expect(deal?.summary).toContain('Annual plan is cheaper today.');
    expect(parseDate(deal?.starts_at)?.toISOString()).toBe('2026-11-27T00:00:00.000Z');
  });

  it('returns [] for malformed input instead of throwing', async () => {
    const adapter = createRssAdapter();
    for (const body of ['', 'not xml at all <<<', '{"json": true}', fixture('blocked-cloudflare.html')]) {
      await expect(adapter.fetchDeals(makeContext({ body }))).resolves.toEqual([]);
    }
  });
});
