/**
 * RawDeal → Deal: currency, dates, discount %, fingerprint.
 *
 * Pure and I/O-free, so it is fully unit-testable. The fingerprint is the
 * idempotency key for the whole system: a delayed or duplicated run produces
 * the same fingerprint, so it cannot create a duplicate row.
 */

import { createHash } from 'node:crypto';
import type { Deal, RawDeal } from './types.js';

export interface NormaliseContext {
  vendorId: number;
  sourceId?: number | null;
  /** Below this, a deal is stored as needs_review instead of published. */
  confidenceFloor: number;
}

/** Case- and whitespace-insensitive comparison form of a title. */
export function normaliseTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Canonical price form used inside the fingerprint. Prices are NUMERIC(12,2)
 * in Postgres and may arrive as JS numbers, so 2dp is the stable spelling.
 */
export function priceKey(price: number | null | undefined): string {
  return price === null || price === undefined || !Number.isFinite(price)
    ? ''
    : price.toFixed(2);
}

/**
 * SHA-256 of vendor_id + normalised title + price_now + promo_code.
 *
 * Same deal, same price → same fingerprint (duplicate is a no-op).
 * Same deal, new price → different fingerprint (the change is detected and
 * the existing row is updated by dedupe instead of duplicated).
 */
export function fingerprint(
  vendorId: number,
  title: string,
  priceNow?: number | null,
  promoCode?: string | null,
): string {
  const canonical = [
    String(vendorId),
    normaliseTitle(title),
    priceKey(priceNow),
    (promoCode ?? '').trim().toLowerCase(),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

/** Discount as a percentage of the original price, or null when unknowable. */
export function computeDiscountPct(
  priceNow?: number | null,
  priceWas?: number | null,
): number | null {
  if (!isNumber(priceNow) || !isNumber(priceWas)) return null;
  if (priceWas <= 0 || priceNow >= priceWas) return null;
  return round2(((priceWas - priceNow) / priceWas) * 100);
}

/** Date | date-string → valid Date, or null. Never returns Invalid Date. */
export function parseDate(value?: string | Date | null): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalise(raw: RawDeal, ctx: NormaliseContext): Deal {
  const title = raw.title.trim();
  const priceNow = toNumber(raw.price_now);
  const priceWas = toNumber(raw.price_was);
  const advertised = toNumber(raw.discount_pct);
  const confidence = clamp01(raw.confidence ?? ctx.confidenceFloor);

  return {
    vendor_id: ctx.vendorId,
    source_id: ctx.sourceId ?? null,
    title,
    summary: raw.summary ?? null,
    price_now: priceNow,
    price_was: priceWas,
    currency: (raw.currency?.trim() || 'USD').toLowerCase(),
    discount_pct:
      advertised !== null && advertised >= 0
        ? round2(advertised)
        : computeDiscountPct(priceNow, priceWas),
    promo_code: raw.promo_code ?? null,
    starts_at: parseDate(raw.starts_at),
    ends_at: parseDate(raw.ends_at),
    url: raw.url ?? null,
    eligibility_note: raw.eligibility_note ?? null,
    confidence,
    status: confidence >= ctx.confidenceFloor ? 'published' : 'needs_review',
    score: null,
    score_breakdown: null,
    fingerprint: fingerprint(ctx.vendorId, title, priceNow, raw.promo_code),
  };
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Adapters can hand numbers through loosely typed JSON; coerce or drop. */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
