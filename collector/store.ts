/**
 * All SQL lives here. Nothing else in the collector talks to Postgres, so the
 * database can be swapped by reimplementing this one module.
 *
 * A4 specifies these as module-level functions; they are grouped into a Store
 * object created from a Pool so that tests can inject an in-memory fake at the
 * same seam the orchestrator uses. Behaviour is otherwise as specified.
 */

import { Pool, types } from 'pg';
import type {
  Deal,
  Health,
  RunSummary,
  ScoreBreakdown,
  Source,
  Target,
  Vendor,
} from './types.js';

// BIGSERIAL comes back as a string and NUMERIC as a string by default. Both are
// numbers in collector/types.ts, so parse them here, once, at the boundary.
types.setTypeParser(20, (value: string) => Number(value)); // int8 (bigserial ids, counts)
types.setTypeParser(1700, (value: string) => Number(value)); // numeric

export interface MarkSourceCheckedInput {
  hash?: string | null;
  changed: boolean;
  ok: boolean;
  error?: string | null;
  /**
   * How many raw deals the adapter produced. Used to detect the §10 "page
   * changed but extraction returned nothing" failure, which has no column of
   * its own in the frozen schema and is therefore tracked in
   * consecutive_failures (>= 2 in a row → degraded).
   */
  dealsFound?: number;
}

export interface Store {
  upsertVendor(vendor: Vendor): Promise<Vendor>;
  upsertSource(vendorId: number, source: Omit<Source, 'id' | 'vendor_id'>): Promise<Source>;
  listDueSources(now: Date): Promise<Array<Source & { vendor: Vendor }>>;
  markSourceChecked(id: number, result: MarkSourceCheckedInput): Promise<void>;
  recordRunStart(): Promise<number>;
  recordRunFinish(runId: number, summary: Omit<RunSummary, 'runId'>): Promise<void>;
  findDealByFingerprint(fingerprint: string): Promise<Deal | null>;
  /** Additive to the A4 list: dedupe's fuzzy pass needs recent same-vendor deals. */
  findRecentDeals(vendorId: number, sinceDays?: number): Promise<Deal[]>;
  /** Additive to the A4 list: alert retry (§10) needs a deal by id. */
  findDealById(id: number): Promise<Deal | null>;
  insertDeal(deal: Deal): Promise<Deal>;
  updateDealSeen(id: number, patch: Partial<Deal>): Promise<void>;
  listActiveTargets(): Promise<Target[]>;
  alertsSentFor(dealId: number): Promise<number>;
  recordAlert(dealId: number, status: 'sent' | 'failed', error?: string): Promise<void>;
}

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 5 });
}

export function createStore(pool: Pool): Store {
  return {
    async upsertVendor(vendor) {
      const { rows } = await pool.query<VendorRow>(
        `INSERT INTO vendor (slug, name, category, tier, website, service_line)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name,
           category = EXCLUDED.category,
           tier = EXCLUDED.tier,
           website = EXCLUDED.website,
           service_line = EXCLUDED.service_line
         RETURNING id, slug, name, category, tier, website, service_line, created_at`,
        [
          vendor.slug,
          vendor.name,
          vendor.category,
          vendor.tier,
          vendor.website ?? null,
          vendor.service_line ?? null,
        ],
      );
      return mapVendor(rows[0]!);
    },

    async upsertSource(vendorId, source) {
      const health: Health = source.enabled ? (source.health ?? 'ok') : 'disabled';
      const { rows } = await pool.query<SourceRow>(
        `INSERT INTO source
           (vendor_id, url, kind, adapter, cadence_minutes, enabled, note, health, consecutive_failures)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)
         ON CONFLICT (vendor_id, url) DO UPDATE SET
           kind = EXCLUDED.kind,
           adapter = EXCLUDED.adapter,
           cadence_minutes = EXCLUDED.cadence_minutes,
           enabled = EXCLUDED.enabled,
           note = EXCLUDED.note,
           health = CASE
             WHEN NOT EXCLUDED.enabled THEN 'disabled'
             WHEN source.health = 'disabled' THEN 'ok'
             ELSE source.health
           END
         RETURNING *`,
        [
          vendorId,
          source.url,
          source.kind,
          source.adapter,
          source.cadence_minutes,
          source.enabled,
          source.note ?? null,
          health,
        ],
      );
      return mapSource(rows[0]!);
    },

    async listDueSources(now) {
      const { rows } = await pool.query<DueSourceRow>(
        `SELECT s.id, s.vendor_id, s.url, s.kind, s.adapter, s.cadence_minutes, s.enabled,
                s.note, s.last_checked_at, s.last_changed_at, s.content_hash,
                s.consecutive_failures, s.health,
                v.slug AS v_slug, v.name AS v_name, v.category AS v_category, v.tier AS v_tier,
                v.website AS v_website, v.service_line AS v_service_line
         FROM source s
         JOIN vendor v ON v.id = s.vendor_id
         WHERE s.enabled
           AND (s.last_checked_at IS NULL
                OR s.last_checked_at + make_interval(mins => s.cadence_minutes) <= $1)
         ORDER BY s.last_checked_at ASC NULLS FIRST, s.id ASC`,
        [now],
      );
      return rows.map((row) => ({ ...mapSource(row), vendor: mapVendorRow(row) }));
    },

    async markSourceChecked(id, result) {
      const changed = result.changed;
      const found = result.dealsFound ?? 0;
      await pool.query(
        `UPDATE source SET
           last_checked_at = now(),
           content_hash = COALESCE($2::text, content_hash),
           last_changed_at = CASE WHEN $3::boolean AND $2::text IS NOT NULL
                                  THEN now() ELSE last_changed_at END,
           consecutive_failures = CASE
             WHEN $4::boolean AND NOT ($3::boolean AND $5::int = 0) THEN 0
             ELSE consecutive_failures + 1
           END,
           health = CASE
             WHEN $4::boolean AND NOT ($3::boolean AND $5::int = 0) THEN 'ok'
             WHEN $4::boolean THEN
               CASE WHEN consecutive_failures + 1 >= 2 THEN 'degraded' ELSE 'ok' END
             ELSE
               CASE
                 WHEN consecutive_failures + 1 > 5 THEN 'failing'
                 WHEN consecutive_failures + 1 > 2 THEN 'degraded'
                 ELSE 'ok'
               END
           END
         WHERE id = $1`,
        [id, result.hash ?? null, changed, result.ok, found],
      );
    },

    async recordRunStart() {
      const { rows } = await pool.query<{ id: number }>(
        'INSERT INTO run_log DEFAULT VALUES RETURNING id',
      );
      return rows[0]!.id;
    },

    async recordRunFinish(runId, summary) {
      await pool.query(
        `UPDATE run_log SET
           finished_at = now(),
           sources_checked = $2,
           sources_failed = $3,
           pages_fetched = $4,
           extractions_ok = $5,
           extractions_low_confidence = $6,
           new_deals = $7,
           errors = $8::jsonb
         WHERE id = $1`,
        [
          runId,
          summary.sourcesChecked,
          summary.sourcesFailed,
          summary.pagesFetched,
          summary.extractionsOk,
          summary.extractionsLowConfidence,
          summary.newDeals,
          JSON.stringify(summary.errors),
        ],
      );
    },

    async findDealByFingerprint(fingerprint) {
      const { rows } = await pool.query<DealRow>('SELECT * FROM deal WHERE fingerprint = $1', [
        fingerprint,
      ]);
      return rows[0] ? mapDeal(rows[0]) : null;
    },

    async findRecentDeals(vendorId, sinceDays = 90) {
      const { rows } = await pool.query<DealRow>(
        `SELECT * FROM deal
         WHERE vendor_id = $1 AND last_seen_at >= now() - make_interval(days => $2::int)
         ORDER BY last_seen_at DESC
         LIMIT 50`,
        [vendorId, sinceDays],
      );
      return rows.map(mapDeal);
    },

    async findDealById(id) {
      const { rows } = await pool.query<DealRow>('SELECT * FROM deal WHERE id = $1', [id]);
      return rows[0] ? mapDeal(rows[0]) : null;
    },

    async insertDeal(deal) {
      const { rows } = await pool.query<DealRow>(
        `INSERT INTO deal
           (vendor_id, source_id, title, summary, price_now, price_was, currency, discount_pct,
            promo_code, starts_at, ends_at, url, eligibility_note, confidence, status, score,
            score_breakdown, fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                 $17::jsonb, $18)
         ON CONFLICT (fingerprint) DO UPDATE SET last_seen_at = now()
         RETURNING *`,
        [
          deal.vendor_id,
          deal.source_id ?? null,
          deal.title,
          deal.summary ?? null,
          deal.price_now ?? null,
          deal.price_was ?? null,
          deal.currency,
          deal.discount_pct ?? null,
          deal.promo_code ?? null,
          deal.starts_at ?? null,
          deal.ends_at ?? null,
          deal.url ?? null,
          deal.eligibility_note ?? null,
          deal.confidence,
          deal.status,
          deal.score ?? null,
          deal.score_breakdown ? JSON.stringify(deal.score_breakdown) : null,
          deal.fingerprint,
        ],
      );
      return mapDeal(rows[0]!);
    },

    async updateDealSeen(id, patch) {
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const column of DEAL_PATCH_COLUMNS) {
        if (!Object.prototype.hasOwnProperty.call(patch, column)) continue;
        params.push(patch[column] ?? null);
        sets.push(`${column} = $${params.length}`);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'score_breakdown')) {
        params.push(patch.score_breakdown ? JSON.stringify(patch.score_breakdown) : null);
        sets.push(`score_breakdown = $${params.length}::jsonb`);
      }
      params.push(id);
      sets.push('last_seen_at = now()');
      await pool.query(`UPDATE deal SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    },

    async listActiveTargets() {
      const { rows } = await pool.query<TargetRow>(
        'SELECT * FROM target WHERE active ORDER BY priority ASC, id ASC',
      );
      return rows.map(mapTarget);
    },

    async alertsSentFor(dealId) {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM alert WHERE deal_id = $1 AND status = 'sent'`,
        [dealId],
      );
      return rows[0]?.n ?? 0;
    },

    async recordAlert(dealId, status, error) {
      await pool.query(
        `INSERT INTO alert (deal_id, channel, status, error)
         VALUES ($1, 'telegram', $2, $3)
         ON CONFLICT DO NOTHING`,
        [dealId, status, error ?? null],
      );
    },
  };
}

/** Columns a patch may touch; ids, vendor_id, fingerprint and first_seen_at are immutable. */
const DEAL_PATCH_COLUMNS = [
  'title',
  'summary',
  'price_now',
  'price_was',
  'currency',
  'discount_pct',
  'promo_code',
  'starts_at',
  'ends_at',
  'url',
  'eligibility_note',
  'confidence',
  'status',
  'score',
] as const satisfies readonly (keyof Deal)[];

interface VendorRow {
  id: number;
  slug: string;
  name: string;
  category: Vendor['category'];
  tier: number;
  website: string | null;
  service_line: string | null;
  created_at: Date;
}

interface SourceRow {
  id: number;
  vendor_id: number;
  url: string;
  kind: Source['kind'];
  adapter: Source['adapter'];
  cadence_minutes: number;
  enabled: boolean;
  note: string | null;
  last_checked_at: Date | null;
  last_changed_at: Date | null;
  content_hash: string | null;
  consecutive_failures: number;
  health: Health;
}

interface DueSourceRow extends SourceRow {
  v_slug: string;
  v_name: string;
  v_category: Vendor['category'];
  v_tier: number;
  v_website: string | null;
  v_service_line: string | null;
}

interface DealRow {
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
  status: Deal['status'];
  score: number | null;
  score_breakdown: ScoreBreakdown | null;
  fingerprint: string;
  first_seen_at: Date;
  last_seen_at: Date;
}

interface TargetRow {
  id: number;
  vendor_id: number | null;
  keyword: string | null;
  max_price: number | null;
  priority: number;
  active: boolean;
}

function mapVendor(row: VendorRow): Vendor {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    category: row.category,
    tier: row.tier === 2 ? 2 : 1,
    website: row.website,
    service_line: row.service_line,
    created_at: row.created_at,
  };
}

function mapVendorRow(row: DueSourceRow): Vendor {
  return {
    id: row.vendor_id,
    slug: row.v_slug,
    name: row.v_name,
    category: row.v_category,
    tier: row.v_tier === 2 ? 2 : 1,
    website: row.v_website,
    service_line: row.v_service_line,
  };
}

function mapSource(row: SourceRow): Source {
  return {
    id: row.id,
    vendor_id: row.vendor_id,
    url: row.url,
    kind: row.kind,
    adapter: row.adapter,
    cadence_minutes: row.cadence_minutes,
    enabled: row.enabled,
    note: row.note,
    last_checked_at: row.last_checked_at,
    last_changed_at: row.last_changed_at,
    content_hash: row.content_hash,
    consecutive_failures: row.consecutive_failures,
    health: row.health,
  };
}

function mapDeal(row: DealRow): Deal {
  return {
    id: row.id,
    vendor_id: row.vendor_id,
    source_id: row.source_id,
    title: row.title,
    summary: row.summary,
    price_now: row.price_now,
    price_was: row.price_was,
    currency: row.currency,
    discount_pct: row.discount_pct,
    promo_code: row.promo_code,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    url: row.url,
    eligibility_note: row.eligibility_note,
    confidence: row.confidence,
    status: row.status,
    score: row.score,
    score_breakdown: row.score_breakdown,
    fingerprint: row.fingerprint,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
  };
}

function mapTarget(row: TargetRow): Target {
  return {
    id: row.id,
    vendor_id: row.vendor_id,
    keyword: row.keyword,
    max_price: row.max_price,
    priority: row.priority,
    active: row.active,
  };
}
