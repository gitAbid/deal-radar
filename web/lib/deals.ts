import { query } from './db';
import { isCategory, type Category, type DealWithVendor } from './types';

export type DealSort = 'score' | 'discount' | 'ending';

export interface DealFilters {
  category: Category | null;
  tier: 1 | 2 | null;
  minDiscount: number | null;
  endingDays: number | null;
  q: string | null;
  sort: DealSort;
}

export const DEAL_PAGE_LIMIT = 200;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function asNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Validate raw searchParams into filters. Anything unrecognised is dropped, so
 * a hand-edited URL can never produce a broken (or unsafe) query.
 */
export function parseDealFilters(
  searchParams: Record<string, string | string[] | undefined>,
): DealFilters {
  const category = first(searchParams.category);
  const tier = first(searchParams.tier);
  const sort = first(searchParams.sort);
  const q = first(searchParams.q)?.trim();

  const minDiscount = asNumber(first(searchParams.min_discount));
  const endingDays = asNumber(first(searchParams.ending_days));

  return {
    category: category && isCategory(category) ? category : null,
    tier: tier === '1' ? 1 : tier === '2' ? 2 : null,
    minDiscount: minDiscount !== null ? Math.min(100, Math.max(0, minDiscount)) : null,
    endingDays: endingDays !== null ? Math.min(365, Math.max(1, Math.round(endingDays))) : null,
    q: q ? q.slice(0, 100) : null,
    sort: sort === 'discount' || sort === 'ending' ? sort : 'score',
  };
}

/** Rebuild a query string from validated filters (used for sort links). */
export function filtersToSearchParams(filters: DealFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.category) params.set('category', filters.category);
  if (filters.tier) params.set('tier', String(filters.tier));
  if (filters.minDiscount !== null) params.set('min_discount', String(filters.minDiscount));
  if (filters.endingDays !== null) params.set('ending_days', String(filters.endingDays));
  if (filters.q) params.set('q', filters.q);
  if (filters.sort !== 'score') params.set('sort', filters.sort);
  return params;
}

const ORDER_BY: Record<DealSort, string> = {
  score: 'd.score DESC NULLS LAST, d.ends_at ASC NULLS LAST, d.id DESC',
  discount: 'd.discount_pct DESC NULLS LAST, d.score DESC NULLS LAST, d.id DESC',
  ending: 'd.ends_at ASC NULLS LAST, d.score DESC NULLS LAST, d.id DESC',
};

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/** Published deals with vendor fields, filtered and sorted. Default: score DESC. */
export async function listDeals(filters: DealFilters): Promise<DealWithVendor[]> {
  const conditions: string[] = [`d.status = 'published'`];
  const values: unknown[] = [];
  const add = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  if (filters.category) conditions.push(`v.category = ${add(filters.category)}`);
  if (filters.tier) conditions.push(`v.tier = ${add(filters.tier)}`);
  if (filters.minDiscount !== null) conditions.push(`d.discount_pct >= ${add(filters.minDiscount)}`);
  if (filters.endingDays !== null) {
    conditions.push(
      `d.ends_at >= now() AND d.ends_at <= now() + make_interval(days => ${add(filters.endingDays)})`,
    );
  }
  if (filters.q) {
    const pattern = add(likePattern(filters.q));
    conditions.push(
      `(d.title ILIKE ${pattern} OR coalesce(d.summary, '') ILIKE ${pattern} OR coalesce(d.promo_code, '') ILIKE ${pattern})`,
    );
  }

  const limit = add(DEAL_PAGE_LIMIT);

  const result = await query<DealWithVendor>(
    `
      SELECT d.*,
             v.name     AS vendor_name,
             v.slug     AS vendor_slug,
             v.category,
             v.tier,
             count(*) OVER () AS total_count
      FROM deal d
      JOIN vendor v ON v.id = d.vendor_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${ORDER_BY[filters.sort]}
      LIMIT ${limit}
    `,
    values,
  );

  return result.rows;
}

/** Used only to choose the right empty-state copy on the deals page. */
export async function countPublishedDeals(): Promise<number> {
  const result = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM deal WHERE status = 'published'`,
  );
  return result.rows[0]?.n ?? 0;
}
