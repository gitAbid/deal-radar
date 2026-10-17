/**
 * Deal Radar — frozen shared types.
 *
 * These mirror db/schema.sql exactly. Column names in interfaces match column
 * names in Postgres, so the store layer can pass rows through without mapping.
 * Any change here must be reflected in db/schema.sql and vice versa.
 */

export type Category = 'llm' | 'media' | 'devtools' | 'hosting' | 'ops' | 'storage';
export type SourceKind = 'rss' | 'api' | 'page';
export type AdapterName = 'rss' | 'hackernews' | 'reddit' | 'llm_page';
export type Health = 'ok' | 'degraded' | 'failing' | 'disabled';
export type DealStatus = 'published' | 'needs_review' | 'rejected' | 'expired';

export interface Vendor {
  id?: number;
  slug: string;
  name: string;
  category: Category;
  tier: 1 | 2;
  website?: string | null;
  service_line?: string | null;
  created_at?: Date;
}

export interface Source {
  id?: number;
  vendor_id: number;
  url: string;
  kind: SourceKind;
  adapter: AdapterName;
  cadence_minutes: number;
  enabled: boolean;
  note?: string | null;
  last_checked_at?: Date | null;
  last_changed_at?: Date | null;
  content_hash?: string | null;
  consecutive_failures: number;
  health: Health;
}

/** What an adapter returns, before normalisation. Everything optional except title. */
export interface RawDeal {
  title: string;
  summary?: string | null;
  price_now?: number | null;
  price_was?: number | null;
  currency?: string | null;
  discount_pct?: number | null;
  promo_code?: string | null;
  starts_at?: string | Date | null;
  ends_at?: string | Date | null;
  url?: string | null;
  eligibility_note?: string | null;
  confidence?: number | null;
}

export interface ScoreBreakdown {
  relevance: number;
  savings_usd: number;
  discount_pct: number;
  urgency: number;
  total: number;
}

export interface Deal {
  id?: number;
  vendor_id: number;
  source_id?: number | null;
  title: string;
  summary?: string | null;
  price_now?: number | null;
  price_was?: number | null;
  currency: string;
  discount_pct?: number | null;
  promo_code?: string | null;
  starts_at?: Date | null;
  ends_at?: Date | null;
  url?: string | null;
  eligibility_note?: string | null;
  confidence: number;
  status: DealStatus;
  score?: number | null;
  score_breakdown?: ScoreBreakdown | null;
  fingerprint: string;
  first_seen_at?: Date;
  last_seen_at?: Date;
}

export interface Target {
  id?: number;
  vendor_id?: number | null;
  keyword?: string | null;
  max_price?: number | null;
  priority: number;
  active: boolean;
}

export interface FetchResult {
  status: number;
  body: string;
  hash: string;
  changed: boolean;
}

export type ClassifyKind = 'NEW' | 'UPDATED' | 'DUPLICATE';

export interface ClassifyResult {
  kind: ClassifyKind;
  existingId?: number;
}

export interface RunError {
  sourceId?: number;
  url?: string;
  message: string;
}

export interface RunSummary {
  runId: number;
  sourcesChecked: number;
  sourcesFailed: number;
  pagesFetched: number;
  extractionsOk: number;
  extractionsLowConfidence: number;
  newDeals: number;
  errors: RunError[];
}

export interface WatchlistSource {
  url: string;
  kind: SourceKind;
  adapter: AdapterName;
  cadence_minutes?: number;
  enabled?: boolean;
  note?: string;
}

export interface WatchlistVendor {
  slug: string;
  name: string;
  category: Category;
  tier: 1 | 2;
  website?: string;
  service_line?: string;
  sources?: WatchlistSource[];
}

export interface Watchlist {
  vendors: WatchlistVendor[];
}

/**
 * Adapter contract. Every adapter is a pure function of (already-fetched body,
 * vendor, source) → RawDeal[]. Adapters never perform I/O except through the
 * injected fetcher, which lets tests run with fixtures and zero network.
 */
export interface AdapterContext {
  vendor: Vendor;
  source: Source;
  /** Already-fetched response body for source.url. Never re-fetch it yourself. */
  body: string;
  /** Use only for follow-up requests (e.g. fetching an article an RSS item links to). */
  fetcher: { fetch(url: string): Promise<FetchResult> };
  /** True when running under --dry-run: adapters may log but must not persist. */
  dryRun: boolean;
}

export interface Adapter {
  name: AdapterName;
  fetchDeals(ctx: AdapterContext): Promise<RawDeal[]>;
}
