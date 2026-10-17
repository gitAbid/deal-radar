import { connection } from 'next/server';
import { listDeals, parseDealFilters } from '@/lib/deals';

/**
 * JSON view of the deals list. Accepts the same query params as `/`:
 *   category, tier, min_discount, ending_days, q, sort=score|discount|ending
 */
export async function GET(request: Request): Promise<Response> {
  await connection();
  try {
    const searchParams = Object.fromEntries(new URL(request.url).searchParams);
    const filters = parseDealFilters(searchParams);
    const deals = await listDeals(filters);
    return Response.json({
      count: deals.length,
      total: deals[0]?.total_count ?? 0,
      filters,
      deals,
    });
  } catch (error) {
    return Response.json(
      {
        error: 'deals_query_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
