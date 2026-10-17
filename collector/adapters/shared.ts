/**
 * Helpers shared by the structured adapters (rss, hackernews, reddit).
 *
 * Every adapter is defensive by contract: adapters never throw, malformed
 * input yields [].
 */

import type { RawDeal, Vendor } from '../types.js';

/** The plan's deal-shaped title filter, applied to non-discovery vendors. */
export const DEAL_PATTERN = /(deal|sale|discount|off|%|promo|black friday)/i;

export const DISCOVERY_CONFIDENCE = 0.5;
export const DISCOVERY_NOTE = 'community mention, unverified';

export const DISCOVERY_FIELDS: Pick<RawDeal, 'confidence' | 'eligibility_note'> = {
  confidence: DISCOVERY_CONFIDENCE,
  eligibility_note: DISCOVERY_NOTE,
};

/** Community feeds are marked with service_line: discovery in watchlist.yaml. */
export function isDiscovery(vendor: Pick<Vendor, 'service_line'>): boolean {
  return vendor.service_line === 'discovery';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Trimmed, length-capped string, or null. */
export function str(value: unknown, max = 300): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** JSON.parse that returns undefined instead of throwing. */
export function jsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** HTML/markdown-ish body → single-line summary, capped. */
export function text(value: unknown, max = 2000): string | null {
  if (typeof value !== 'string') return null;
  const plain = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain === '') return null;
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/** Epoch seconds (number or numeric string) → ISO string, or null. */
export function epochToIso(value: unknown): string | null {
  const seconds =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
