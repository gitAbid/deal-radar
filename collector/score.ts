/**
 * Pure scoring. No I/O, no clock reads, no randomness.
 *
 *   score = 3·relevance + 2·log10(savings_usd + 1) + 1.5·(discount_pct/10) + 2·urgency
 *
 * Weights are overridable so they can be tuned without touching this file.
 * `now` and the vendor record are injected rather than read from the world,
 * which keeps the function deterministic under test.
 */

import type { Deal, ScoreBreakdown, Target, Vendor } from './types.js';

export interface ScoreWeights {
  relevance: number;
  savings: number;
  discount: number;
  urgency: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  relevance: 3,
  savings: 2,
  discount: 1.5,
  urgency: 2,
};

export interface ScoreContext {
  /** Injectable clock for the urgency term. */
  now?: Date;
  /** Only `service_line` is read; the rest of the vendor is not needed. */
  vendor?: Pick<Vendor, 'service_line'> | null;
}

export interface ScoreResult {
  score: number;
  breakdown: ScoreBreakdown;
}

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Does the deal match an active target? Used to gate alerts, and identical to
 * the vendor/keyword half of the relevance term.
 *
 * No FX rates are available in v1, so savings are treated as USD.
 */
export function matchesTarget(deal: Deal, targets: Target[]): boolean {
  const haystack = searchText(deal);
  return targets.some((t) => {
    if (!t.active) return false;
    if (t.vendor_id !== null && t.vendor_id !== undefined && t.vendor_id === deal.vendor_id) {
      return true;
    }
    const keyword = t.keyword?.trim().toLowerCase();
    return keyword !== undefined && keyword !== '' && haystack.includes(keyword);
  });
}

export function score(
  deal: Deal,
  targets: Target[],
  weights: ScoreWeights = DEFAULT_WEIGHTS,
  ctx: ScoreContext = {},
): ScoreResult {
  const now = ctx.now ?? new Date();
  const relevance = relevanceScore(deal, targets, ctx.vendor ?? null);
  const savingsUsd = savings(deal);
  const discountPct = discount(deal);
  const urgency = urgencyScore(deal, now);

  const raw =
    weights.relevance * relevance +
    weights.savings * Math.log10(savingsUsd + 1) +
    weights.discount * (discountPct / 10) +
    weights.urgency * urgency;

  const total = round3(raw);
  return {
    score: total,
    breakdown: { relevance, savings_usd: savingsUsd, discount_pct: discountPct, urgency, total },
  };
}

function relevanceScore(
  deal: Deal,
  targets: Target[],
  vendor: Pick<Vendor, 'service_line'> | null,
): number {
  const active = targets.filter((t) => t.active);
  if (active.some((t) => t.vendor_id !== null && t.vendor_id !== undefined && t.vendor_id === deal.vendor_id)) {
    return 5;
  }
  const haystack = searchText(deal);
  const keywordHit = active.some((t) => {
    const keyword = t.keyword?.trim().toLowerCase();
    return keyword !== undefined && keyword !== '' && haystack.includes(keyword);
  });
  if (keywordHit) return 3;
  if (vendor?.service_line) return 2;
  return 0;
}

function searchText(deal: Deal): string {
  return `${deal.title}\n${deal.summary ?? ''}`.toLowerCase();
}

function savings(deal: Deal): number {
  const now = deal.price_now;
  const was = deal.price_was;
  if (typeof now !== 'number' || typeof was !== 'number') return 0;
  if (!Number.isFinite(now) || !Number.isFinite(was)) return 0;
  return was > now ? round2(was - now) : 0;
}

function discount(deal: Deal): number {
  return typeof deal.discount_pct === 'number' && Number.isFinite(deal.discount_pct) && deal.discount_pct > 0
    ? deal.discount_pct
    : 0;
}

function urgencyScore(deal: Deal, now: Date): number {
  if (!deal.ends_at) return 0;
  const endsAt = new Date(deal.ends_at).getTime();
  if (!Number.isFinite(endsAt)) return 0;
  const remaining = endsAt - now.getTime();
  if (remaining <= 0) return 0;
  if (remaining <= 72 * HOUR_MS) return 2;
  if (remaining <= 7 * DAY_MS) return 1;
  return 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
