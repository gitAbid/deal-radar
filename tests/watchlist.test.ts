import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_KIND,
  ADAPTERS,
  CATEGORIES,
  WatchlistError,
  loadWatchlist,
  sourcesFromWatchlist,
  vendorFromWatchlist,
} from '../collector/watchlist.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('the real watchlist.yaml', () => {
  const watchlist = loadWatchlist();

  it('parses and contains the seeded vendor set', () => {
    expect(watchlist.vendors.length).toBeGreaterThan(40);
  });

  it('has unique slugs and well-formed vendors', () => {
    const slugs = watchlist.vendors.map((v) => v.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const vendor of watchlist.vendors) {
      expect(vendor.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(CATEGORIES).toContain(vendor.category);
      expect([1, 2]).toContain(vendor.tier);
      expect(vendor.name.length).toBeGreaterThan(0);
    }
  });

  it('has only known adapters, each matching its source kind', () => {
    for (const vendor of watchlist.vendors) {
      for (const source of vendor.sources ?? []) {
        expect(ADAPTERS).toContain(source.adapter);
        expect(ADAPTER_KIND[source.adapter]).toBe(source.kind);
        expect(source.url).toMatch(/^https?:\/\//);
      }
    }
  });

  it('covers all four adapters', () => {
    const used = new Set(
      watchlist.vendors.flatMap((v) => (v.sources ?? []).map((s) => s.adapter)),
    );
    expect([...used].sort()).toEqual(['hackernews', 'llm_page', 'reddit', 'rss']);
  });

  it('marks community feeds as the discovery service line', () => {
    for (const slug of ['hacker-news', 'reddit-selfhosted', 'reddit-localllama', 'reddit-webdev', 'lowendtalk']) {
      const vendor = watchlist.vendors.find((v) => v.slug === slug);
      expect(vendor, slug).toBeDefined();
      expect(vendor?.service_line, slug).toBe('discovery');
    }
  });
});

describe('source records derived from the watchlist', () => {
  it('defaults cadence by tier and honours explicit cadence', () => {
    const watchlist = loadWatchlist();
    const openai = watchlist.vendors.find((v) => v.slug === 'openai');
    expect(openai).toBeDefined();
    const [openaiSource] = sourcesFromWatchlist(openai!);
    expect(openaiSource?.cadence_minutes).toBe(15);

    const xai = watchlist.vendors.find((v) => v.slug === 'xai');
    expect(xai).toBeDefined();
    expect(sourcesFromWatchlist(xai!)).toEqual([]); // no sources: watched via community feeds

    const hackerNews = watchlist.vendors.find((v) => v.slug === 'hacker-news');
    const hackerNewsSources = sourcesFromWatchlist(hackerNews!);
    expect(hackerNewsSources.map((s) => s.cadence_minutes)).toEqual([30, 60]);
  });

  it('maps vendors to their column-shaped record', () => {
    const watchlist = loadWatchlist();
    const entry = watchlist.vendors.find((v) => v.slug === 'openai')!;
    const vendor = vendorFromWatchlist(entry);
    expect(vendor).toMatchObject({ slug: 'openai', category: 'llm', tier: 1 });
    expect(vendor.service_line).toBeNull();
  });

  it('defaults enabled/health for sources', () => {
    const watchlist = loadWatchlist();
    const entry = watchlist.vendors.find((v) => v.slug === 'hetzner')!;
    const [source] = sourcesFromWatchlist(entry);
    expect(source).toMatchObject({ enabled: true, health: 'ok', consecutive_failures: 0 });
  });
});

describe('validation failures name the offending line', () => {
  it('rejects an unknown category and points at the vendor line', () => {
    let error: unknown;
    try {
      loadWatchlist(fixture('watchlist-bad.yaml'));
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(WatchlistError);
    const wlError = error as WatchlistError;
    expect(wlError.message).toMatch(/watchlist-bad\.yaml:3:/);
    expect(wlError.message).toMatch(/category/);
    expect(wlError.line).toBe(3);
  });
});
