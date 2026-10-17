import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS, matchesTarget, score } from '../collector/score.js';
import type { Deal, Target } from '../collector/types.js';

const NOW = new Date('2026-10-17T12:00:00.000Z');

function deal(overrides: Partial<Deal> = {}): Deal {
  return {
    vendor_id: 1,
    title: 'Black Friday deal',
    currency: 'usd',
    confidence: 0.9,
    status: 'published',
    fingerprint: 'f'.repeat(64),
    ...overrides,
  };
}

function target(overrides: Partial<Target> = {}): Target {
  return { priority: 3, active: true, ...overrides };
}

describe('relevance', () => {
  it('is 0 with no targets and no service line', () => {
    expect(score(deal(), []).breakdown.relevance).toBe(0);
  });

  it('is 5 when an active target names the vendor', () => {
    const targets = [target({ vendor_id: 1 })];
    expect(score(deal(), targets).breakdown.relevance).toBe(5);
  });

  it('is 0 when the vendor target is inactive', () => {
    const targets = [target({ vendor_id: 1, active: false })];
    expect(score(deal(), targets).breakdown.relevance).toBe(0);
  });

  it('is 3 for a keyword match, case-insensitively, in title or summary', () => {
    const targets = [target({ keyword: 'BLACK FRIDAY' })];
    expect(score(deal(), targets).breakdown.relevance).toBe(3);
    expect(score(deal({ title: 'nothing here', summary: 'a black friday sale' }), targets).breakdown.relevance).toBe(3);
    expect(score(deal({ title: 'nothing', summary: 'nothing' }), targets).breakdown.relevance).toBe(0);
  });

  it('is 2 when the vendor has a service line and no target matches', () => {
    const targets = [target({ keyword: 'unrelated' })];
    expect(score(deal(), targets, DEFAULT_WEIGHTS, { vendor: { service_line: 'content' } }).breakdown.relevance).toBe(2);
  });

  it('prefers the vendor target over a keyword and over a service line', () => {
    const targets = [target({ vendor_id: 1 }), target({ keyword: 'black friday' })];
    expect(
      score(deal(), targets, DEFAULT_WEIGHTS, { vendor: { service_line: 'content' } }).breakdown.relevance,
    ).toBe(5);
  });
});

describe('savings and discount', () => {
  it('reports savings_usd only when price_was exceeds price_now', () => {
    expect(score(deal({ price_now: 40, price_was: 100 }), []).breakdown.savings_usd).toBe(60);
    expect(score(deal({ price_now: 40 }), []).breakdown.savings_usd).toBe(0);
    expect(score(deal({ price_now: 120, price_was: 100 }), []).breakdown.savings_usd).toBe(0);
  });

  it('uses discount_pct, defaulting to 0', () => {
    expect(score(deal({ discount_pct: 50 }), []).breakdown.discount_pct).toBe(50);
    expect(score(deal(), []).breakdown.discount_pct).toBe(0);
  });

  it('applies the documented formula', () => {
    const d = deal({ vendor_id: 1, price_now: 40, price_was: 100, discount_pct: 60, ends_at: null });
    const result = score(d, [target({ vendor_id: 1 })], DEFAULT_WEIGHTS, { now: NOW });
    // 3*5 + 2*log10(60+1) + 1.5*(60/10) + 2*0
    const expected = 15 + 2 * Math.log10(61) + 9;
    expect(result.score).toBe(Math.round(expected * 1000) / 1000);
    expect(result.breakdown.total).toBe(result.score);
  });

  it('honours weight overrides', () => {
    const d = deal({ price_now: 40, price_was: 100 });
    const result = score(d, [], { relevance: 1, savings: 1, discount: 1, urgency: 1 }, { now: NOW });
    expect(result.score).toBe(Math.round(1 * Math.log10(61) * 1000) / 1000);
  });
});

describe('urgency', () => {
  it('is 2 within 72 hours (inclusive), 1 within 7 days, 0 otherwise', () => {
    const at = (ms: number) => deal({ ends_at: new Date(NOW.getTime() + ms) });
    expect(score(at(72 * 3600_000), [], DEFAULT_WEIGHTS, { now: NOW }).breakdown.urgency).toBe(2);
    expect(score(at(72 * 3600_000 + 1000), [], DEFAULT_WEIGHTS, { now: NOW }).breakdown.urgency).toBe(1);
    expect(score(at(7 * 24 * 3600_000), [], DEFAULT_WEIGHTS, { now: NOW }).breakdown.urgency).toBe(1);
    expect(score(at(7 * 24 * 3600_000 + 1000), [], DEFAULT_WEIGHTS, { now: NOW }).breakdown.urgency).toBe(0);
  });

  it('is 0 for past dates and missing ends_at', () => {
    expect(score(deal({ ends_at: new Date('2026-10-01T00:00:00Z') }), [], DEFAULT_WEIGHTS, { now: NOW }).breakdown.urgency).toBe(0);
    expect(score(deal(), [], DEFAULT_WEIGHTS, { now: NOW }).breakdown.urgency).toBe(0);
  });
});

describe('determinism', () => {
  it('returns the same result for identical input', () => {
    const d = deal({ price_now: 40, price_was: 100, ends_at: new Date('2026-10-20T12:00:00Z') });
    const targets = [target({ vendor_id: 1 })];
    expect(score(d, targets, DEFAULT_WEIGHTS, { now: NOW })).toEqual(
      score(d, targets, DEFAULT_WEIGHTS, { now: NOW }),
    );
  });
});

describe('matchesTarget', () => {
  it('matches an active vendor target', () => {
    expect(matchesTarget(deal(), [target({ vendor_id: 1 })])).toBe(true);
  });

  it('matches an active keyword target case-insensitively', () => {
    expect(matchesTarget(deal({ title: 'BLACK FRIDAY' }), [target({ keyword: 'black friday' })])).toBe(true);
  });

  it('ignores inactive targets and unrelated ones', () => {
    expect(matchesTarget(deal(), [target({ vendor_id: 1, active: false })])).toBe(false);
    expect(matchesTarget(deal(), [target({ vendor_id: 99 })])).toBe(false);
  });
});
