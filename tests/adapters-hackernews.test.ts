import { describe, expect, it } from 'vitest';
import { createHackerNewsAdapter } from '../collector/adapters/hackernews.js';
import { parseDate } from '../collector/normalise.js';
import { fixture, makeContext, makeVendor } from './helpers.js';

const DEAL_RE = /(deal|sale|discount|off|%|promo|black friday)/i;
const discoveryVendor = (): ReturnType<typeof makeVendor> =>
  makeVendor({ slug: 'hacker-news', service_line: 'discovery' });

describe('hackernews adapter', () => {
  it('is named hackernews', () => {
    expect(createHackerNewsAdapter().name).toBe('hackernews');
  });

  it('parses the real Algolia fixture and filters to deal-shaped titles', async () => {
    const deals = await createHackerNewsAdapter().fetchDeals(
      makeContext({ body: fixture('hackernews-search.json') }),
    );
    expect(deals.length).toBeGreaterThan(3);
    for (const deal of deals) {
      expect(DEAL_RE.test(deal.title)).toBe(true);
    }
    const titles = deals.map((d) => d.title);
    expect(titles).toContain('Bloody Black Friday for Hardware [video]');
    expect(titles).not.toContain(
      'Show HN: Funxy – A typed scripting language that embeds into Go apps',
    );
  });

  it('emits every hit of a discovery vendor at confidence 0.5, flagged unverified', async () => {
    const deals = await createHackerNewsAdapter().fetchDeals(
      makeContext({ body: fixture('hackernews-search.json'), vendor: discoveryVendor() }),
    );
    expect(deals).toHaveLength(10);
    for (const deal of deals) {
      expect(deal.confidence).toBe(0.5);
      expect(deal.eligibility_note).toBe('community mention, unverified');
    }
    // Hits with no external url fall back to the HN discussion.
    const discussion = deals.filter((d) => d.url?.startsWith('https://news.ycombinator.com/item?id='));
    expect(discussion.length).toBeGreaterThan(0);
  });

  it('maps created_at/url/summary onto RawDeal', async () => {
    const deals = await createHackerNewsAdapter().fetchDeals(
      makeContext({ body: fixture('hackernews-search.json'), vendor: discoveryVendor() }),
    );
    const first = deals[0];
    expect(parseDate(first?.starts_at)).toBeInstanceOf(Date);
    expect(first?.url).toMatch(/^https?:\/\//);
  });

  it('returns [] for malformed input instead of throwing', async () => {
    const adapter = createHackerNewsAdapter();
    const bodies = [
      '',
      'not json',
      '{}',
      '{"hits":{}}',
      '{"hits":[null,{"title":123},{"title":""}]}',
      fixture('blocked-cloudflare.html'),
    ];
    for (const body of bodies) {
      await expect(adapter.fetchDeals(makeContext({ body }))).resolves.toEqual([]);
    }
  });
});
