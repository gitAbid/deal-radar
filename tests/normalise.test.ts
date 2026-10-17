import { describe, expect, it } from 'vitest';
import {
  computeDiscountPct,
  fingerprint,
  normalise,
  parseDate,
} from '../collector/normalise.js';
import type { RawDeal } from '../collector/types.js';

const HEX64 = /^[0-9a-f]{64}$/;
const ctx = { vendorId: 7, sourceId: 3, confidenceFloor: 0.6 };

function raw(overrides: Partial<RawDeal> = {}): RawDeal {
  return { title: 'Cursor Pro — Black Friday 50% off', ...overrides };
}

describe('fingerprint', () => {
  it('is a stable SHA-256 hex digest', () => {
    const fp = fingerprint(1, 'Big SALE', 40, 'BF26');
    expect(fp).toMatch(HEX64);
    expect(fingerprint(1, 'Big SALE', 40, 'BF26')).toBe(fp);
  });

  it('is case- and whitespace-insensitive on the title', () => {
    expect(fingerprint(1, '  Big   SALE ', 40, 'bf26')).toBe(
      fingerprint(1, 'big sale', 40, 'BF26'),
    );
  });

  it('produces a different fingerprint for the same deal at a different price', () => {
    expect(fingerprint(1, 'Big SALE', 40, null)).not.toBe(fingerprint(1, 'Big SALE', 30, null));
  });

  it('produces a different fingerprint for a different vendor', () => {
    expect(fingerprint(1, 'Big SALE', 40, null)).not.toBe(fingerprint(2, 'Big SALE', 40, null));
  });

  it('produces a different fingerprint for a different promo code', () => {
    expect(fingerprint(1, 'Big SALE', 40, 'BF26')).not.toBe(fingerprint(1, 'Big SALE', 40, 'CYBER'));
  });

  it('treats missing price and promo code consistently', () => {
    expect(fingerprint(1, 'x', null, null)).toBe(fingerprint(1, 'x', undefined, undefined));
    expect(fingerprint(1, 'x', 40, null)).not.toBe(fingerprint(1, 'x', null, null));
  });
});

describe('computeDiscountPct', () => {
  it('computes the discount percentage', () => {
    expect(computeDiscountPct(40, 100)).toBe(60);
    expect(computeDiscountPct(1, 3)).toBe(66.67);
  });

  it('returns null when either price is missing', () => {
    expect(computeDiscountPct(null, 100)).toBeNull();
    expect(computeDiscountPct(40, null)).toBeNull();
    expect(computeDiscountPct(undefined, undefined)).toBeNull();
  });

  it('returns null for a price rise rather than a negative number', () => {
    expect(computeDiscountPct(120, 100)).toBeNull();
  });

  it('returns null when the price has not changed', () => {
    expect(computeDiscountPct(100, 100)).toBeNull();
  });
});

describe('parseDate', () => {
  it('returns null for null, empty and unparseable values', () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate('definitely not a date')).toBeNull();
    expect(parseDate(new Date('nope'))).toBeNull();
  });

  it('parses ISO strings', () => {
    expect(parseDate('2026-11-27T00:00:00.000Z')?.toISOString()).toBe('2026-11-27T00:00:00.000Z');
  });

  it('passes valid Date instances through', () => {
    const d = new Date('2026-10-17T12:00:00.000Z');
    expect(parseDate(d)).toEqual(d);
  });
});

describe('normalise', () => {
  it('defaults currency to USD (stored lowercase)', () => {
    expect(normalise(raw(), ctx).currency).toBe('usd');
  });

  it('lowercases a supplied currency', () => {
    expect(normalise(raw({ currency: 'EUR' }), ctx).currency).toBe('eur');
  });

  it('clamps confidence into 0..1', () => {
    expect(normalise(raw({ confidence: -1 }), ctx).confidence).toBe(0);
    expect(normalise(raw({ confidence: 2 }), ctx).confidence).toBe(1);
  });

  it('falls back to the confidence floor when a raw deal states no confidence', () => {
    expect(normalise(raw(), ctx).confidence).toBe(0.6);
  });

  it('marks a deal at or above the floor published and below it needs_review', () => {
    expect(normalise(raw({ confidence: 0.6 }), ctx).status).toBe('published');
    expect(normalise(raw({ confidence: 0.59 }), ctx).status).toBe('needs_review');
  });

  it('uses an advertised discount, otherwise computes one from the prices', () => {
    expect(normalise(raw({ price_now: 40, price_was: 100 }), ctx).discount_pct).toBe(60);
    expect(
      normalise(raw({ price_now: 40, price_was: 100, discount_pct: 55 }), ctx).discount_pct,
    ).toBe(55);
    expect(normalise(raw({ price_now: 40 }), ctx).discount_pct).toBeNull();
  });

  it('carries vendor/source through and derives the fingerprint from the raw fields', () => {
    const d = normalise(raw({ price_now: 40, promo_code: 'BF26' }), ctx);
    expect(d.vendor_id).toBe(7);
    expect(d.source_id).toBe(3);
    expect(d.fingerprint).toBe(fingerprint(7, 'Cursor Pro — Black Friday 50% off', 40, 'BF26'));
  });

  it('normalises unparseable dates to null and trims the title', () => {
    const d = normalise(
      raw({ title: '  Spaced out  ', starts_at: 'nope', ends_at: '2026-11-27T23:59:00.000Z' }),
      ctx,
    );
    expect(d.title).toBe('Spaced out');
    expect(d.starts_at).toBeNull();
    expect(d.ends_at?.toISOString()).toBe('2026-11-27T23:59:00.000Z');
  });
});
