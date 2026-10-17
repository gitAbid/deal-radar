/**
 * End-to-end: runOnce() with an in-memory Store, a fake fetcher, fixture
 * adapters, and mocked Telegram/heartbeat. No network, no database.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FetchError, type Fetcher } from '../collector/fetcher.js';
import { runOnce } from '../collector/index.js';
import { fingerprint } from '../collector/normalise.js';
import type { Store, MarkSourceCheckedInput } from '../collector/store.js';
import type {
  Adapter,
  AdapterName,
  Deal,
  Health,
  RunSummary,
  Source,
  Target,
  Vendor,
} from '../collector/types.js';
import { makeSource, makeVendor } from './helpers.js';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

const rssBody = '<?xml version="1.0"?><rss version="2.0"><channel><title>c</title></channel></rss>';
const anthropicBody = '<html><body>Anthropic pricing</body></html>';
const hnBody = '{"hits":[]}';

class FakeStore implements Store {
  readonly calls: string[] = [];
  readonly deals = new Map<number, Deal>();
  readonly alerts: Array<{ dealId: number; status: 'sent' | 'failed' }> = [];
  readonly runs: Array<Omit<RunSummary, 'runId'>> = [];
  private nextDealId = 1;
  private nextRunId = 1;

  constructor(
    private readonly sources: Array<Source & { vendor: Vendor }>,
    private readonly targets: Target[] = [],
  ) {}

  async upsertVendor(): Promise<Vendor> {
    throw new Error('not used');
  }

  async upsertSource(): Promise<Source> {
    throw new Error('not used');
  }

  async listDueSources(): Promise<Array<Source & { vendor: Vendor }>> {
    this.calls.push('listDueSources');
    return this.sources;
  }

  async markSourceChecked(id: number, result: MarkSourceCheckedInput): Promise<void> {
    this.calls.push(
      `markSourceChecked:${id}:ok=${result.ok}:changed=${result.changed}:found=${result.dealsFound ?? 0}`,
    );
    const source = this.sources.find((s) => s.id === id);
    if (source) {
      if (result.hash !== undefined && result.hash !== null) source.content_hash = result.hash;
      source.last_checked_at = new Date();
      if (result.ok) {
        source.consecutive_failures = 0;
        source.health = 'ok' as Health;
      } else {
        source.consecutive_failures += 1;
        source.health = source.consecutive_failures > 2 ? 'degraded' : 'ok';
      }
    }
  }

  async recordRunStart(): Promise<number> {
    this.calls.push('recordRunStart');
    return this.nextRunId++;
  }

  async recordRunFinish(_runId: number, summary: Omit<RunSummary, 'runId'>): Promise<void> {
    this.calls.push('recordRunFinish');
    this.runs.push(summary);
  }

  async findDealByFingerprint(fp: string): Promise<Deal | null> {
    return [...this.deals.values()].find((d) => d.fingerprint === fp) ?? null;
  }

  async findRecentDeals(vendorId: number): Promise<Deal[]> {
    return [...this.deals.values()].filter((d) => d.vendor_id === vendorId);
  }

  async findDealById(id: number): Promise<Deal | null> {
    return this.deals.get(id) ?? null;
  }

  async insertDeal(deal: Deal): Promise<Deal> {
    const id = this.nextDealId++;
    const stored: Deal = { ...deal, id, first_seen_at: new Date(), last_seen_at: new Date() };
    this.deals.set(id, stored);
    this.calls.push(`insertDeal:${stored.status}`);
    return stored;
  }

  async updateDealSeen(id: number, patch: Partial<Deal>): Promise<void> {
    const existing = this.deals.get(id);
    if (!existing) throw new Error(`no deal ${id}`);
    this.deals.set(id, { ...existing, ...patch, last_seen_at: new Date() });
    this.calls.push('updateDealSeen');
  }

  async listActiveTargets(): Promise<Target[]> {
    return this.targets;
  }

  async alertsSentFor(dealId: number): Promise<number> {
    return this.alerts.filter((a) => a.dealId === dealId && a.status === 'sent').length;
  }

  async recordAlert(dealId: number, status: 'sent' | 'failed', _error?: string): Promise<void> {
    this.alerts.push({ dealId, status });
    this.calls.push(`recordAlert:${status}`);
  }
}

interface WorldOptions {
  notify?: () => 'sent' | 'failed';
}

function makeWorld(options: WorldOptions = {}) {
  const cursor = makeVendor({ id: 1, slug: 'cursor', name: 'Cursor', category: 'devtools' });
  const anthropic = makeVendor({ id: 2, slug: 'anthropic', name: 'Anthropic', category: 'llm' });
  const hackerNews = makeVendor({
    id: 3,
    slug: 'hacker-news',
    name: 'Hacker News',
    category: 'hosting',
    service_line: 'discovery',
  });

  const sources: Array<Source & { vendor: Vendor }> = [
    { ...makeSource({ id: 11, vendor_id: 1, url: 'https://cursor.com/rss', kind: 'rss', adapter: 'rss' }), vendor: cursor },
    { ...makeSource({ id: 12, vendor_id: 2, url: 'https://anthropic.com/pricing', kind: 'page', adapter: 'llm_page' }), vendor: anthropic },
    { ...makeSource({ id: 13, vendor_id: 3, url: 'https://hn.algolia.com/search', kind: 'api', adapter: 'hackernews' }), vendor: hackerNews },
  ];
  const targets: Target[] = [{ id: 1, vendor_id: 1, priority: 1, active: true }];
  const store = new FakeStore(sources, targets);

  const bodies = new Map<string, string>([
    ['https://cursor.com/rss', rssBody],
    ['https://anthropic.com/pricing', anthropicBody],
    ['https://hn.algolia.com/search', hnBody],
  ]);
  const fetcher: Fetcher = {
    async fetch(url, fetchOptions) {
      const body = bodies.get(url);
      if (body === undefined) throw new FetchError(`HTTP 404 for ${url}`, url, 404);
      const hash = sha(body);
      const cached = fetchOptions?.cache?.hash ?? null;
      if (fetchOptions?.kind === 'page' && cached === hash) {
        return { status: 304, body: '', hash, changed: false };
      }
      return { status: 200, body, hash, changed: cached !== hash };
    },
  };

  const adapterCalls = { rss: 0, llm_page: 0, hackernews: 0 };
  const adapters: Partial<Record<AdapterName, Adapter>> = {
    rss: {
      name: 'rss',
      async fetchDeals() {
        adapterCalls.rss += 1;
        return [
          {
            title: 'Cursor Pro — Black Friday 50% off',
            price_now: 40,
            price_was: 100,
            promo_code: 'BF26',
            url: 'https://cursor.com/pricing',
          },
        ];
      },
    },
    llm_page: {
      name: 'llm_page',
      async fetchDeals() {
        adapterCalls.llm_page += 1;
        return [{ title: 'Anthropic is doing something vague', confidence: 0.3 }];
      },
    },
    hackernews: {
      name: 'hackernews',
      async fetchDeals() {
        adapterCalls.hackernews += 1;
        throw new Error('vendor blocked automation');
      },
    },
  };

  const notifyCalls: Array<{ vendorName: string; dealId: number | undefined }> = [];
  let pings = 0;
  const deps = {
    store,
    fetcher,
    adapters,
    notify: async (deal: Deal, vendorName: string) => {
      notifyCalls.push({ vendorName, dealId: deal.id });
      return { status: options.notify?.() ?? ('sent' as const) };
    },
    ping: async () => {
      pings += 1;
    },
    now: () => new Date('2026-10-17T12:00:00.000Z'),
  };

  return { store, sources, deps, adapterCalls, notifyCalls, pings: () => pings };
}

describe('runOnce', () => {
  it('isolates a failing source, gates the LLM on change detection, and stores by confidence', async () => {
    const { store, deps, adapterCalls, notifyCalls, pings } = makeWorld();

    const summary = await runOnce({ deps });

    // The hackernews source threw; the run continued.
    expect(summary.sourcesChecked).toBe(2);
    expect(summary.sourcesFailed).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.message).toContain('blocked automation');
    expect(summary.errors[0]?.sourceId).toBe(13);
    expect(adapterCalls.hackernews).toBe(1);

    // One published deal, one needs_review from below the confidence floor.
    expect(summary.newDeals).toBe(1);
    const deals = [...store.deals.values()];
    expect(deals).toHaveLength(2);

    const published = deals.find((d) => d.status === 'published');
    expect(published?.vendor_id).toBe(1);
    expect(published?.fingerprint).toBe(
      fingerprint(1, 'Cursor Pro — Black Friday 50% off', 40, 'BF26'),
    );
    expect(published?.score).toBeGreaterThanOrEqual(8);
    expect(published?.score_breakdown?.relevance).toBe(5);

    const review = deals.find((d) => d.status === 'needs_review');
    expect(review?.vendor_id).toBe(2);
    expect(review?.confidence).toBeCloseTo(0.3);

    // Alerted once, for the published deal that matches an active target.
    expect(notifyCalls.map((c) => c.vendorName)).toEqual(['Cursor']);
    expect(store.alerts).toEqual([{ dealId: published?.id, status: 'sent' }]);

    // Run log + heartbeat.
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]?.sourcesChecked).toBe(2);
    expect(store.runs[0]?.newDeals).toBe(1);
    expect(pings()).toBe(1);
  });

  it('re-running the same fixtures inserts zero new deals and re-extracts nothing', async () => {
    const { store, deps, adapterCalls, notifyCalls } = makeWorld();

    await runOnce({ deps });
    const dealsAfterFirst = store.deals.size;

    const second = await runOnce({ deps });

    expect(second.newDeals).toBe(0);
    expect(store.deals.size).toBe(dealsAfterFirst);
    // The page was unchanged, so the LLM path was never entered again.
    expect(adapterCalls.llm_page).toBe(1);
    expect(store.calls).toContain('markSourceChecked:12:ok=true:changed=false:found=0');
    // The rss source is not page-gated, so it is re-read; dedupe stops the insert.
    expect(adapterCalls.rss).toBe(2);
    expect(notifyCalls).toHaveLength(1);
    expect(store.alerts).toHaveLength(1);
  });

  it('retries a failed alert on the next run, then stops (§10)', async () => {
    let outcome: 'sent' | 'failed' = 'failed';
    const { store, deps, notifyCalls } = makeWorld({ notify: () => outcome });

    await runOnce({ deps });
    expect(store.alerts).toEqual([{ dealId: expect.any(Number), status: 'failed' }]);

    outcome = 'sent';
    await runOnce({ deps });
    expect(store.alerts).toHaveLength(2);
    expect(store.alerts[1]?.status).toBe('sent');

    await runOnce({ deps });
    expect(store.alerts).toHaveLength(2); // already sent: never a third time
    expect(notifyCalls).toHaveLength(2);
  });

  it('writes nothing at all in dry-run mode', async () => {
    const { store, deps, notifyCalls, pings } = makeWorld();

    const summary = await runOnce({ dryRun: true, deps });

    expect(summary.runId).toBe(0);
    expect(summary.newDeals).toBe(1); // what a real run would have inserted
    expect(store.deals.size).toBe(0);
    expect(store.runs).toHaveLength(0);
    expect(notifyCalls).toHaveLength(0);
    expect(pings()).toBe(0);
    expect(store.calls.filter((c) => c.startsWith('insertDeal'))).toEqual([]);
    expect(store.calls.filter((c) => c.startsWith('markSourceChecked'))).toEqual([]);
    expect(store.calls).not.toContain('recordRunStart');
    expect(store.calls).not.toContain('recordRunFinish');
    expect(store.calls).not.toContain('recordAlert:sent');
  });
});
