/**
 * Fingerprint first, fuzzy title match second → NEW | UPDATED | DUPLICATE.
 *
 * The fingerprint is exact and cheap (it is the unique key in Postgres), so it
 * carries the idempotency guarantee. The fuzzy pass exists for the case the
 * fingerprint deliberately does not cover: the same offer reappearing with a
 * new price, or a feed rewording its title. Without it, a vendor that truncates
 * prices differently each run would create a new row every time.
 *
 * The candidate set (same vendor, recently seen) comes from the store; all the
 * matching logic is pure and lives here.
 */

import type { ClassifyResult, Deal } from './types.js';
import { priceKey } from './normalise.js';

/** Jaccard similarity at or above this counts as the same offer. */
export const FUZZY_THRESHOLD = 0.8;

export interface DedupeSource {
  findDealByFingerprint(fingerprint: string): Promise<Deal | null>;
  findRecentDeals(vendorId: number): Promise<Deal[]>;
}

/** Comparison form: lowercase, punctuation collapsed to single spaces. */
export function titleKey(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Jaccard similarity of the token sets of two titles, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const left = new Set(titleKey(a).split(' ').filter(Boolean));
  const right = new Set(titleKey(b).split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export async function classify(deal: Deal, source: DedupeSource): Promise<ClassifyResult> {
  const exact = await source.findDealByFingerprint(deal.fingerprint);
  if (exact?.id !== undefined) return { kind: 'DUPLICATE', existingId: exact.id };

  const candidates = await source.findRecentDeals(deal.vendor_id);
  let best: { deal: Deal; similarity: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.id === undefined) continue;
    // An expired row is a past offer that happens to share a name; a fresh
    // deal is NEW, not an update of something that is over.
    if (candidate.status === 'expired') continue;
    const similarity = titleSimilarity(deal.title, candidate.title);
    if (similarity >= FUZZY_THRESHOLD && (best === null || similarity > best.similarity)) {
      best = { deal: candidate, similarity };
    }
  }

  if (!best) return { kind: 'NEW' };

  const changed =
    priceKey(deal.price_now) !== priceKey(best.deal.price_now) ||
    priceKey(deal.price_was) !== priceKey(best.deal.price_was) ||
    (deal.promo_code ?? '').trim().toLowerCase() !==
      (best.deal.promo_code ?? '').trim().toLowerCase();

  return { kind: changed ? 'UPDATED' : 'DUPLICATE', existingId: best.deal.id };
}
