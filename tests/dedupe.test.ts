import { describe, expect, it } from 'vitest';
import { classify, titleKey, titleSimilarity } from '../collector/dedupe.js';
import { fingerprint } from '../collector/normalise.js';
import type { Deal } from '../collector/types.js';
import type { DedupeSource } from '../collector/dedupe.js';

function deal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: 1,
    vendor_id: 1,
    title: 'Cursor Pro — Black Friday 50% off',
    price_now: 10,
    price_was: 20,
    currency: 'usd',
    promo_code: 'BF26',
    confidence: 0.9,
    status: 'published',
    fingerprint: fingerprint(1, 'Cursor Pro — Black Friday 50% off', 10, 'BF26'),
    ...overrides,
  };
}

function fakeStore(rows: Deal[]): DedupeSource {
  return {
    async findDealByFingerprint(fp) {
      return rows.find((r) => r.fingerprint === fp) ?? null;
    },
    async findRecentDeals(vendorId) {
      return rows.filter((r) => r.vendor_id === vendorId);
    },
  };
}

describe('titleKey / titleSimilarity', () => {
  it('key is case-, punctuation- and whitespace-insensitive', () => {
    expect(titleKey('  Cursor Pro — 50% OFF! ')).toBe('cursor pro 50 off');
  });

  it('similarity is 1 for identical keys and 0 for disjoint ones', () => {
    expect(titleSimilarity('black friday deal', 'Black Friday DEAL')).toBe(1);
    expect(titleSimilarity('black friday deal', 'completely different')).toBe(0);
  });
});

describe('classify', () => {
  it('is NEW when no fingerprint and no similar deal exists', async () => {
    const result = await classify(deal(), fakeStore([]));
    expect(result).toEqual({ kind: 'NEW' });
  });

  it('is DUPLICATE for the same fingerprint (re-run is a no-op)', async () => {
    const existing = deal();
    const result = await classify(deal(), fakeStore([existing]));
    expect(result.kind).toBe('DUPLICATE');
    expect(result.existingId).toBe(1);
  });

  it('is UPDATED when the same deal reappears at a different price', async () => {
    const existing = deal({ price_now: 10, fingerprint: fingerprint(1, 'Cursor Pro — Black Friday 50% off', 10, 'BF26') });
    const incoming = deal({ price_now: 8, fingerprint: fingerprint(1, 'Cursor Pro — Black Friday 50% off', 8, 'BF26') });
    const result = await classify(incoming, fakeStore([existing]));
    expect(result.kind).toBe('UPDATED');
    expect(result.existingId).toBe(1);
  });

  it('is DUPLICATE when the title is only reworded and the price is unchanged', async () => {
    const existing = deal({ title: 'Cursor Pro: black friday 50% OFF', fingerprint: 'a'.repeat(64) });
    const incoming = deal({ title: 'Cursor Pro — Black Friday 50% off', fingerprint: 'b'.repeat(64) });
    const result = await classify(incoming, fakeStore([existing]));
    expect(result.kind).toBe('DUPLICATE');
    expect(result.existingId).toBe(1);
  });

  it('ignores deals from other vendors', async () => {
    const existing = deal({ vendor_id: 2, fingerprint: 'c'.repeat(64) });
    const result = await classify(deal(), fakeStore([existing]));
    expect(result.kind).toBe('NEW');
  });

  it('is NEW for a different offer from the same vendor', async () => {
    const existing = deal({ title: 'Cursor Pro annual plan discount', fingerprint: 'd'.repeat(64) });
    const result = await classify(deal(), fakeStore([existing]));
    expect(result.kind).toBe('NEW');
  });
});
