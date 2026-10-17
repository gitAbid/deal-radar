import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../collector/env.js';
import { fingerprint, normalise } from '../collector/normalise.js';
import { createPool, createStore, type Store } from '../collector/store.js';
import type { Source, Vendor } from '../collector/types.js';

// Locally the repo-root .env supplies this; in CI (no secret) the suite skips.
loadEnv();
const databaseUrl = process.env.DATABASE_URL;

const suite = databaseUrl ? describe : describe.skip;

suite('store (live database)', () => {
  const slug = `itest-store-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  let pool: Pool;
  let store: Store;
  let vendor: Vendor;
  let source: Source;
  let runId = 0;
  let dealId = 0;

  beforeAll(() => {
    pool = createPool(databaseUrl as string);
    store = createStore(pool);
  });

  afterAll(async () => {
    if (pool) {
      if (vendor?.id !== undefined) await pool.query('DELETE FROM vendor WHERE id = $1', [vendor.id]);
      if (runId) await pool.query('DELETE FROM run_log WHERE id = $1', [runId]);
      await pool.end();
    }
  });

  it('upserts a vendor by slug, idempotently', async () => {
    vendor = await store.upsertVendor({
      slug,
      name: 'Integration Store Test',
      category: 'devtools',
      tier: 2,
      website: 'https://example.invalid',
    });
    expect(vendor.id).toBeGreaterThan(0);
    expect(vendor.slug).toBe(slug);

    const again = await store.upsertVendor({
      slug,
      name: 'Integration Store Test (renamed)',
      category: 'devtools',
      tier: 2,
    });
    expect(again.id).toBe(vendor.id);
    expect(again.name).toBe('Integration Store Test (renamed)');
    vendor = again;
  });

  it('upserts a source by (vendor_id, url) and lists it as due', async () => {
    source = await store.upsertSource(vendor.id as number, {
      url: 'https://example.invalid/feed.rss',
      kind: 'rss',
      adapter: 'rss',
      cadence_minutes: 360,
      enabled: true,
      note: 'integration test',
      consecutive_failures: 0,
      health: 'ok',
    });
    expect(source.id).toBeGreaterThan(0);

    const again = await store.upsertSource(vendor.id as number, {
      url: 'https://example.invalid/feed.rss',
      kind: 'rss',
      adapter: 'rss',
      cadence_minutes: 15,
      enabled: true,
      consecutive_failures: 0,
      health: 'ok',
    });
    expect(again.id).toBe(source.id);
    expect(again.cadence_minutes).toBe(15);
    // The watchlist is declarative: an omitted note clears the stored one.
    expect(again.note).toBeNull();

    const withNote = await store.upsertSource(vendor.id as number, {
      url: 'https://example.invalid/feed.rss',
      kind: 'rss',
      adapter: 'rss',
      cadence_minutes: 15,
      enabled: true,
      note: 'integration test',
      consecutive_failures: 0,
      health: 'ok',
    });
    expect(withNote.note).toBe('integration test');
    source = withNote;

    const due = await store.listDueSources(new Date());
    const mine = due.find((s) => s.id === source.id);
    expect(mine).toBeDefined();
    expect(mine?.vendor.slug).toBe(slug);
    expect(mine?.vendor.name).toBe('Integration Store Test (renamed)');
  });

  it('marks a source checked: success resets failures and stores the hash', async () => {
    await store.markSourceChecked(source.id as number, {
      hash: 'h'.repeat(64),
      changed: true,
      ok: true,
      dealsFound: 2,
    });
    const due = await store.listDueSources(new Date());
    expect(due.find((s) => s.id === source.id)).toBeUndefined(); // cadence 15m, just checked

    const { rows } = await pool.query<{
      consecutive_failures: number;
      health: string;
      content_hash: string;
      last_changed_at: Date | null;
    }>('SELECT consecutive_failures, health, content_hash, last_changed_at FROM source WHERE id = $1', [source.id]);
    expect(rows[0]?.consecutive_failures).toBe(0);
    expect(rows[0]?.health).toBe('ok');
    expect(rows[0]?.content_hash).toBe('h'.repeat(64));
    expect(rows[0]?.last_changed_at).not.toBeNull();
  });

  it('degrades and then fails a source after repeated failures', async () => {
    const read = async () => {
      const { rows } = await pool.query<{ consecutive_failures: number; health: string }>(
        'SELECT consecutive_failures, health FROM source WHERE id = $1',
        [source.id],
      );
      return rows[0];
    };

    await store.markSourceChecked(source.id as number, { changed: false, ok: false, error: 'boom 1' });
    expect(await read()).toMatchObject({ consecutive_failures: 1, health: 'ok' });
    await store.markSourceChecked(source.id as number, { changed: false, ok: false, error: 'boom 2' });
    await store.markSourceChecked(source.id as number, { changed: false, ok: false, error: 'boom 3' });
    expect(await read()).toMatchObject({ consecutive_failures: 3, health: 'degraded' });
    for (let i = 4; i <= 6; i += 1) {
      await store.markSourceChecked(source.id as number, { changed: false, ok: false, error: `boom ${i}` });
    }
    expect(await read()).toMatchObject({ consecutive_failures: 6, health: 'failing' });
  });

  it('degrades a source that keeps changing while yielding no deals (spec §10)', async () => {
    await store.markSourceChecked(source.id as number, { hash: 'x'.repeat(64), changed: true, ok: true, dealsFound: 1 });
    await store.markSourceChecked(source.id as number, { hash: 'y'.repeat(64), changed: true, ok: true, dealsFound: 0 });
    const first = await pool.query<{ consecutive_failures: number; health: string }>(
      'SELECT consecutive_failures, health FROM source WHERE id = $1',
      [source.id],
    );
    expect(first.rows[0]).toMatchObject({ consecutive_failures: 1, health: 'ok' });

    await store.markSourceChecked(source.id as number, { hash: 'z'.repeat(64), changed: true, ok: true, dealsFound: 0 });
    const second = await pool.query<{ consecutive_failures: number; health: string }>(
      'SELECT consecutive_failures, health FROM source WHERE id = $1',
      [source.id],
    );
    expect(second.rows[0]).toMatchObject({ consecutive_failures: 2, health: 'degraded' });
  });

  it('records a run and finishes it', async () => {
    runId = await store.recordRunStart();
    expect(runId).toBeGreaterThan(0);
    await store.recordRunFinish(runId, {
      sourcesChecked: 3,
      sourcesFailed: 1,
      pagesFetched: 4,
      extractionsOk: 2,
      extractionsLowConfidence: 1,
      newDeals: 5,
      errors: [{ sourceId: 42, url: 'https://example.invalid', message: 'boom' }],
    });
    const { rows } = await pool.query<{ sources_checked: number; errors: unknown; finished_at: Date | null }>(
      'SELECT sources_checked, errors, finished_at FROM run_log WHERE id = $1',
      [runId],
    );
    expect(rows[0]?.sources_checked).toBe(3);
    expect(rows[0]?.finished_at).not.toBeNull();
    expect(rows[0]?.errors).toEqual([{ sourceId: 42, url: 'https://example.invalid', message: 'boom' }]);
  });

  it('inserts a deal twice without duplicating (fingerprint is the idempotency key)', async () => {
    const deal = normalise(
      { title: 'Integration Deal', price_now: 40, price_was: 100, promo_code: 'ITEST' },
      { vendorId: vendor.id as number, sourceId: source.id ?? null, confidenceFloor: 0.6 },
    );
    const inserted = await store.insertDeal(deal);
    dealId = inserted.id as number;
    expect(dealId).toBeGreaterThan(0);
    expect(inserted.fingerprint).toBe(fingerprint(vendor.id as number, 'Integration Deal', 40, 'ITEST'));
    expect(inserted.price_now).toBe(40);
    expect(inserted.confidence).toBeCloseTo(0.6, 5);

    const again = await store.insertDeal(deal);
    expect(again.id).toBe(dealId);

    const byFp = await store.findDealByFingerprint(deal.fingerprint);
    expect(byFp?.id).toBe(dealId);
    expect(byFp?.score_breakdown).toBeNull();
  });

  it('reads deals back by id and in recent-deal candidates, and updates them', async () => {
    const byId = await store.findDealById(dealId);
    expect(byId?.id).toBe(dealId);

    const recent = await store.findRecentDeals(vendor.id as number);
    expect(recent.map((d) => d.id)).toContain(dealId);

    await store.updateDealSeen(dealId, { price_now: 30, discount_pct: 70, score: 12.5 });
    const updated = await store.findDealById(dealId);
    expect(updated?.price_now).toBe(30);
    expect(updated?.discount_pct).toBe(70);
    expect(updated?.score).toBeCloseTo(12.5, 3);
    expect(updated?.last_seen_at?.getTime()).toBeGreaterThanOrEqual(updated?.first_seen_at?.getTime() ?? 0);
  });

  it('counts only successful alerts and round-trips the errors field', async () => {
    expect(await store.alertsSentFor(dealId)).toBe(0);
    await store.recordAlert(dealId, 'failed', 'telegram 500');
    expect(await store.alertsSentFor(dealId)).toBe(0);
    await store.recordAlert(dealId, 'sent');
    expect(await store.alertsSentFor(dealId)).toBe(1);
    await store.recordAlert(dealId, 'sent'); // unique partial index: no second sent row
    expect(await store.alertsSentFor(dealId)).toBe(1);
  });

  it('lists active targets', async () => {
    const targets = await store.listActiveTargets();
    expect(Array.isArray(targets)).toBe(true);
  });
});
