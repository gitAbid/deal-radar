import { describe, expect, it } from 'vitest';
import { createRedditAdapter } from '../collector/adapters/reddit.js';
import { parseDate } from '../collector/normalise.js';
import { fixture, makeContext, makeVendor } from './helpers.js';

const discoveryVendor = (): ReturnType<typeof makeVendor> =>
  makeVendor({ slug: 'reddit-selfhosted', service_line: 'discovery' });

describe('reddit adapter', () => {
  it('is named reddit', () => {
    expect(createRedditAdapter().name).toBe('reddit');
  });

  it('filters a non-discovery vendor down to deal-shaped titles', async () => {
    const deals = await createRedditAdapter().fetchDeals(
      makeContext({ body: fixture('reddit-search.json'), vendor: makeVendor({ service_line: null }) }),
    );
    expect(deals.map((d) => d.title)).toEqual([
      'Black Friday 2026: Hetzner cloud is 40% off',
      'Backblaze B2 promo code: 25% off the first year',
    ]);
  });

  it('emits every child of a discovery vendor at confidence 0.5, flagged unverified', async () => {
    const deals = await createRedditAdapter().fetchDeals(
      makeContext({ body: fixture('reddit-search.json'), vendor: discoveryVendor() }),
    );
    expect(deals).toHaveLength(3);
    for (const deal of deals) {
      expect(deal.confidence).toBe(0.5);
      expect(deal.eligibility_note).toBe('community mention, unverified');
    }
  });

  it('converts created_utc epoch seconds into a date and prefers external urls', async () => {
    const deals = await createRedditAdapter().fetchDeals(
      makeContext({ body: fixture('reddit-search.json'), vendor: discoveryVendor() }),
    );
    const hetzner = deals.find((d) => d.title.includes('Hetzner'));
    expect(parseDate(hetzner?.starts_at)?.toISOString()).toBe(
      new Date(1793000000 * 1000).toISOString(),
    );
    expect(hetzner?.url).toBe('https://www.hetzner.com/cloud/');
    expect(hetzner?.summary).toContain('CX22');

    const homelab = deals.find((d) => d.title.includes('homelab'));
    expect(homelab?.url).toBe('https://www.reddit.com/r/selfhosted/comments/2abcde/my_homelab/');
  });

  it('returns [] for malformed input instead of throwing', async () => {
    const adapter = createRedditAdapter();
    const bodies = [
      '',
      'not json',
      '{}',
      '{"data":{}}',
      '{"data":{"children":"nope"}}',
      '{"data":{"children":[null,{"data":null},{"data":{"title":42}}]}}',
      fixture('reddit-blocked.html'),
      fixture('blocked-cloudflare.html'),
    ];
    for (const body of bodies) {
      await expect(adapter.fetchDeals(makeContext({ body }))).resolves.toEqual([]);
    }
  });
});
