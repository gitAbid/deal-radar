/**
 * Dashboard-side mirrors of the frozen contracts in `collector/types.ts` and
 * `db/schema.sql`. Field names match exactly — rows from Postgres are rendered
 * without mapping. Declared here (rather than imported) because `web/` is a
 * standalone deployable that must not reference files outside its own tree.
 */

export type Category = 'llm' | 'media' | 'devtools' | 'hosting' | 'ops' | 'storage';
export type SourceKind = 'rss' | 'api' | 'page';
export type AdapterName = 'rss' | 'hackernews' | 'reddit' | 'llm_page';
export type Health = 'ok' | 'degraded' | 'failing' | 'disabled';
export type DealStatus = 'published' | 'needs_review' | 'rejected' | 'expired';

export const CATEGORIES: readonly Category[] = ['llm', 'media', 'devtools', 'hosting', 'ops', 'storage'];

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

/** Row shape of `deal` (NUMERIC/BIGINT arrive as numbers — see lib/db.ts). */
export interface DealRow {
  id: number;
  vendor_id: number;
  source_id: number | null;
  title: string;
  summary: string | null;
  price_now: number | null;
  price_was: number | null;
  currency: string;
  discount_pct: number | null;
  promo_code: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  url: string | null;
  eligibility_note: string | null;
  confidence: number;
  status: DealStatus;
  score: number | null;
  score_breakdown: unknown;
  fingerprint: string;
  first_seen_at: Date;
  last_seen_at: Date;
}

export interface DealWithVendor extends DealRow {
  vendor_name: string;
  vendor_slug: string;
  category: Category;
  tier: number;
  /** Rows matching the filters, from count(*) OVER () — same on every row. */
  total_count: number;
}

/** Row shape of `source`. */
export interface SourceRow {
  id: number;
  vendor_id: number;
  url: string;
  kind: SourceKind;
  adapter: AdapterName;
  cadence_minutes: number;
  enabled: boolean;
  note: string | null;
  last_checked_at: Date | null;
  last_changed_at: Date | null;
  content_hash: string | null;
  consecutive_failures: number;
  health: Health;
}

export interface SourceWithVendor extends SourceRow {
  vendor_name: string;
  vendor_slug: string;
  category: Category;
  tier: number;
}

/** Row shape of `target`. */
export interface TargetRow {
  id: number;
  vendor_id: number | null;
  keyword: string | null;
  max_price: number | null;
  priority: number;
  active: boolean;
}

export interface TargetWithVendor extends TargetRow {
  vendor_name: string | null;
}

/** Row shape of `run_log`. `errors` is JSONB; it is validated before rendering. */
export interface RunLogRow {
  id: number;
  started_at: Date;
  finished_at: Date | null;
  sources_checked: number;
  sources_failed: number;
  pages_fetched: number;
  extractions_ok: number;
  extractions_low_confidence: number;
  new_deals: number;
  errors: unknown;
}

/** Mirrors RunError in collector/types.ts — the expected shape inside run_log.errors. */
export interface RunError {
  sourceId?: number;
  url?: string;
  message?: string;
}
